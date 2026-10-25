import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stub, json, body, contract, config, agent, home } from './helpers.test.mjs'
import { Runtime } from '../lib/runtime.ts'
import { createTools } from '../lib/tools.ts'
import { EngramHttpError } from '../lib/client.ts'
import { SatelliteEndError } from '../lib/satellite.ts'

async function harness(t, options = {}) {
  const registrations = [], writes = [], ends = [], events = []
  let clock = 0, capability = true, attempts = 0, failEnd = false
  const { url } = await stub(t, async (req, res) => {
    events.push(req.url)
    if (req.url === '/runtime-contract') return json(res, contract())
    if (req.url.startsWith('/project/current')) {
      const cwd = new URL(req.url, 'http://local').searchParams.get('cwd')
      return json(res, { project: cwd === '/target' ? 'other' : 'current', project_source: 'config' })
    }
    if (req.url === '/health') return json(res, { capabilities: { root_session_resume: true, isolated_session_registration: capability } })
    const data = ['POST', 'PATCH'].includes(req.method) ? await body(req) : undefined
    if (req.url === '/sessions') {
      attempts++; registrations.push(data)
      if (options.retry && attempts === 1) { capability = false; req.socket.destroy(); return }
      if (options.conflict) return json(res, { code: 'session_isolation_conflict', error: 'isolation conflict' }, 409)
      return json(res, { id: options.ack ?? data.id, status: 'created' }, 201)
    }
    if (req.url.endsWith('/end')) {
      ends.push(decodeURIComponent(req.url.split('/')[2]))
      if (failEnd && req.url.includes('%40')) return json(res, { error: 'end rejected' }, 503)
      return json(res, { id: decodeURIComponent(req.url.split('/')[2]), status: 'completed' })
    }
    if (req.url.endsWith('/finalize')) return json(res, { session_id: decodeURIComponent(req.url.split('/')[2]), state: 'finalized', summary_id: 9, summary_sync_id: 'obs-9', already_finalized: false })
    writes.push(data); json(res, { id: writes.length, status: 'saved' }, 201)
  })
  const runtime = new Runtime(config(url), () => clock), host = agent('a'), exec = { agent: host }
  return { runtime, host, exec, tools: Object.fromEntries(createTools(runtime).map(tool => [tool.name, tool])), registrations, writes, ends, events,
    capability: value => { capability = value }, advance: () => { clock += 60001 }, failEnd: value => { failEnd = value } }
}
test('only four explicit write tools target satellites; implicit writes and matching projects keep root', async t => {
  const h = await harness(t)
  for (const name of ['mem_save', 'mem_save_prompt', 'mem_session_summary', 'mem_session_finalize']) {
    const root = await h.runtime.prepare(h.host)
    assert.equal((await h.runtime.satellites.resolve(name, h.host, root, {})).satellite, false)
    assert.equal((await h.runtime.satellites.resolve(name, h.host, root, { project: 'other' })).id, 'a@other')
    assert.equal((await h.runtime.satellites.resolve(name, h.host, root, { project: 'CURRENT' })).id, 'a')
  }
  const root = await h.runtime.prepare(h.host)
  assert.equal((await h.runtime.satellites.resolve('mem_capture_passive', h.host, root, { project: 'other' })).satellite, false)
  await h.tools.mem_save.execute({ title: 'other', content: 'body', project: 'other' }, h.exec)
  assert.equal(h.writes.at(-1).session_id, 'a@other'); assert.equal(h.writes.at(-1).project, 'other')
  const registration = h.registrations[0]
  assert.equal(Object.hasOwn(registration, 'directory'), false); assert.equal(registration.isolated, true); assert.equal(registration.resume, true)
  await h.tools.mem_save.execute({ title: 'root', content: 'body' }, h.exec)
  assert.equal(h.writes.at(-1).session_id, 'a'); assert.equal(h.writes.at(-1).project, 'current')
})
test('cwd is resolved, matching project allowed, disagreement fails before registration', async t => {
  const h = await harness(t)
  await assert.rejects(h.tools.mem_save.execute({ title: 'x', content: 'body', cwd: '/target', project: 'wrong' }, h.exec), /does not match/)
  assert.equal(h.registrations.length, 0)
  await h.tools.mem_save.execute({ title: 'x', content: 'body', cwd: '/target', project: 'other' }, h.exec)
  assert.equal(h.writes.at(-1).session_id, 'a@other')
  assert.equal(h.writes.at(-1).project_provenance.directory, '/target')
})
test('satellite capability gates every registration retry and missing capability never writes', async t => {
  const h = await harness(t); h.capability(false)
  await assert.rejects(h.tools.mem_save.execute({ title: 'x', content: 'body', project: 'other' }, h.exec), /isolated_session_registration/)
  assert.equal(h.registrations.length, 0); assert.equal(h.writes.length, 0)
  const retry = await harness(t, { retry: true })
  await assert.rejects(retry.tools.mem_save.execute({ title: 'x', content: 'body', project: 'other' }, retry.exec), /isolated_session_registration/)
  assert.equal(retry.registrations.length, 1); assert.equal(retry.writes.length, 0)
  assert.ok(retry.events.filter(e => e === '/health').length >= 2)
})
test('isolation conflict and malformed acknowledgement fail closed', async t => {
  const h = await harness(t, { conflict: true })
  await assert.rejects(h.tools.mem_save.execute({ title: 'x', content: 'body', project: 'other' }, h.exec), e => e instanceof EngramHttpError && e.status === 409 && e.code === 'session_isolation_conflict')
  for (const ack of ['unrelated', 'a@other:resume:', 'a@other:resume:0']) {
    const bad = await harness(t, { ack })
    await assert.rejects(bad.tools.mem_save.execute({ title: 'x', content: 'body', project: 'other' }, bad.exec), /acknowledgement/)
    assert.equal(bad.writes.length, 0)
  }
})
test('resumed satellite receipts, 60-second renewal and prompt/summary/finalize attribution', async t => {
  const h = await harness(t, { ack: 'a@other:resume:3' })
  await h.tools.mem_save_prompt.execute({ content: 'prompt', project: 'other' }, h.exec)
  assert.equal(h.writes.at(-1).session_id, 'a@other:resume:3')
  await h.tools.mem_session_summary.execute({ content: 'summary', project: 'other' }, h.exec)
  assert.equal(h.registrations.length, 1)
  h.advance()
  await h.tools.mem_session_summary.execute({ content: 'renewed', project: 'other' }, h.exec)
  assert.equal(h.registrations.length, 2)
  const result = await h.tools.mem_session_finalize.execute({ summary: 'summary', project: 'other' }, h.exec)
  assert.equal(result.session_id, 'a@other:resume:3')
})
test('root end precedes satellite ends; partial failure reports root fact and can retry cleanup', async t => {
  const h = await harness(t)
  await h.tools.mem_save.execute({ title: 'other', content: 'body', project: 'other' }, h.exec)
  await h.tools.mem_save.execute({ title: 'root', content: 'body' }, h.exec)
  h.failEnd(true)
  await assert.rejects(h.tools.mem_session_end.execute({}, h.exec), e => e instanceof SatelliteEndError && e.rootEnded === true && /other.*end rejected/.test(e.message))
  assert.deepEqual(h.ends, ['a', 'a@other'])
  assert.equal(h.runtime.sessions.states.size, 0)
  h.failEnd(false)
  await h.tools.mem_session_end.execute({}, h.exec)
  assert.deepEqual(h.ends, ['a', 'a@other', 'a@other'])
  assert.equal(h.runtime.sessions.states.size, 0)
})
