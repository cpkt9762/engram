import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../index.ts'
import { stub, json, contract, agent, body, fakeContext } from './helpers.test.mjs'

async function setup(t, handler) {
  const h = fakeContext(), errors = [], warnings = []
  h.ctx.logger = () => ({ error: (...args) => errors.push(args), warn: (...args) => warnings.push(args) })
  const { url } = await stub(t, handler)
  apply(h.ctx, { url })
  return { ...h, errors, warnings, tools: Object.fromEntries(h.tools.map(tool => [tool.name, tool])), host: agent() }
}
test('persistent contract failures log error once per reason, with no token', async t => {
  const token = 'test-diagnostic-token'
  process.env.ENGRAM_HTTP_TOKEN = token
  t.after(() => { delete process.env.ENGRAM_HTTP_TOKEN })
  let missing = false
  const h = await setup(t, (req, res) => json(res, missing ? {} : { ...contract(), revision: 999 }, missing ? 404 : 200))
  for (let i = 0; i < 3; i++) await assert.rejects(h.tools.mem_current_project.execute({}, { agent: h.host }), /projection mismatch/)
  assert.equal(h.errors.length, 1); assert.equal(h.warnings.length, 0)
  missing = true
  await assert.rejects(h.tools.mem_current_project.execute({}, { agent: h.host }), /missing or unavailable contract/)
  assert.equal(h.errors.length, 2)
  assert.ok(!JSON.stringify(h.errors).includes(token))
})
test('missing resume capability is visible once even for foreground writes', async t => {
  const h = await setup(t, (req, res) => {
    if (req.url === '/runtime-contract') return json(res, contract())
    if (req.url.startsWith('/project/current')) return json(res, { project: 'current' })
    json(res, { capabilities: { root_session_resume: false } })
  })
  for (let i = 0; i < 3; i++) await assert.rejects(h.tools.mem_save.execute({ title: 'title', content: 'content' }, { agent: h.host }), /root_session_resume/)
  assert.equal(h.errors.length, 1); assert.equal(h.warnings.length, 0)
})
test('HOME explicit-project requirement is a persistent visible configuration error', async t => {
  const h = await setup(t, (req, res) => {
    if (req.url === '/runtime-contract') return json(res, contract())
    json(res, { code: 'explicit_project_required' }, 409)
  })
  for (let i = 0; i < 3; i++) await assert.rejects(h.tools.mem_context.execute({}, { agent: h.host }), /Explicit project required/)
  assert.equal(h.errors.length, 1); assert.equal(h.warnings.length, 0)
})
test('one-off background capture failures retain warn severity', async t => {
  const h = await setup(t, async (req, res) => {
    if (req.url === '/runtime-contract') return json(res, contract())
    if (req.url.startsWith('/project/current')) return json(res, { project: 'current' })
    if (req.url === '/health') return json(res, { capabilities: { root_session_resume: true } })
    const data = await body(req)
    if (req.url === '/sessions') return json(res, { id: data.id, status: 'created' })
    json(res, { error: 'temporary capture failure' }, 500)
  })
  h.events['agent/inbox/inserted']({ agent: h.host, message: { source: { kind: 'user' }, content: [{ type: 'text', text: 'one-off capture failure must remain a warning' }] } })
  await h.events['agent/turn-stopping']({ agent: h.host })
  assert.equal(h.errors.length, 0); assert.equal(h.warnings.length, 1)
  assert.match(h.warnings[0].join(' '), /temporary capture failure/)
})
test('foreign and legacy ownership failures report once per owner state through the runtime', async t => {
  const { writeFile } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const { home, config } = await import('./helpers.test.mjs')
  const { Runtime } = await import('../lib/runtime.ts')
  let health = { instance_id: 'b'.repeat(32) }, now = 0
  const { url } = await stub(t, (req, res) => json(res, health))
  const executable = join(home, 'diagnostic-engram')
  await writeFile(executable, `#!${process.execPath}\nif(process.argv[2]!=='instance-id') throw new Error('unexpected spawn'); console.log('${'a'.repeat(32)}')\n`, { mode: 0o700 })
  const errors = [], warnings = []
  const runtime = new Runtime({ ...config(undefined), port: Number(new URL(url).port), engramBin: executable }, () => now, { error: (...args) => errors.push(args), warn: (...args) => warnings.push(args) })
  for (let i = 0; i < 3; i++) await assert.rejects(runtime.prepare(agent()), /foreign/)
  assert.equal(errors.length, 1); assert.equal(warnings.length, 0)
  health = { version: '1.0.0' }; now = 5001
  await assert.rejects(runtime.prepare(agent()), /legacy/)
  assert.equal(errors.length, 2)
})
test('diagnostic sanitization covers token and private blocks; drain timeout stays warn', async () => {
  const { ConfigurationError, Diagnostics } = await import('../lib/diagnostics.ts')
  const { WriteQueues } = await import('../lib/queue.ts')
  const token = 'test-token-sensitive', errors = [], warnings = []
  const diagnostics = new Diagnostics({ error: (...args) => errors.push(args), warn: (...args) => warnings.push(args) }, token)
  for (let i = 0; i < 3; i++) diagnostics.report('configuration', new ConfigurationError('test', `invalid ${token} <private>private detail</private>`))
  assert.equal(errors.length, 1)
  assert.ok(!JSON.stringify(errors).includes(token)); assert.ok(!JSON.stringify(errors).includes('private detail'))
  let release
  const queues = new WriteQueues(message => diagnostics.warn(message))
  const active = queues.run('a', () => new Promise(resolve => { release = resolve }))
  assert.equal(await queues.drain('a', 10), false)
  release(); await active
  assert.equal(warnings.length, 1); assert.equal(errors.length, 1)
  assert.match(warnings[0].join(' '), /timed out/)
})
