import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Compaction, recoveryNotice } from '../lib/compaction.ts'
import { Runtime } from '../lib/runtime.ts'
import { EngramUnknownOutcomeError } from '../lib/client.ts'
import { agent, home, config } from './helpers.test.mjs'
const event = (id = 'c1', text = 'authoritative compacted summary') => ({ type: 'compaction/summary', data: { compactionId: id, summary: [{ type: 'text', text }] } })

test('all four recovery templates contain no interpolation or summary/user data', () => {
  for (const outcome of ['confirmed', 'unknown', 'failed', 'unavailable']) {
    const text = recoveryNotice(outcome)
    assert.ok(text.length > 50); assert.ok(!text.includes('{{'))
    assert.doesNotMatch(text, /MCP tools|Pi-native|authoritative compacted summary/)
  }
  assert.match(recoveryNotice('confirmed'), /already saved/)
  assert.match(recoveryNotice('unknown'), /Do NOT retry/)
  assert.match(recoveryNotice('failed'), /FIRST ACTION REQUIRED/)
  assert.match(recoveryNotice('unavailable'), /did not archive/)
})
test('compaction dedupe is scoped by agent and bounded to 256 event identities', () => {
  const jobs = [], compaction = new Compaction({ queue: { enqueue: (id, job) => jobs.push({ id, job }) } })
  const session = { id: 'a', header: { cwd: home } }
  compaction.event(session, { type: 'other', data: {} })
  compaction.event(session, event('empty', ''))
  compaction.event(session, event())
  compaction.event(session, event())
  assert.equal(jobs.length, 1)
  compaction.event({ ...session, id: 'b' }, event()); assert.equal(jobs.length, 2)
  for (let i = 1; i <= 256; i++) compaction.event(session, event('c' + i))
  const prior = jobs.length
  compaction.event(session, event()); assert.equal(jobs.length, prior + 1, 'oldest event is evicted')
})
for (const outcome of ['confirmed', 'unknown', 'failed', 'unavailable']) {
  test(`compaction ${outcome}: archive fields, agent-local delivery and clear-after-delivery`, async () => {
    const runtime = new Runtime(config('http://127.0.0.1:1'))
    const host = agent(), session = { id: host.id, header: host.session.header }
    const project = { cwd: home, project: '{{unsafe-project}}', provenance: { source: 'config', directory: home }, response: {} }
    runtime.prepare = async () => { if (outcome === 'unavailable') throw new Error('project unavailable'); return project }
    runtime.sessions.register = async () => ({ ...project, effectiveId: 'effective', registeredAt: 0 })
    let written
    runtime.sessions.write = async (id, owner, payload) => {
      written = payload
      if (outcome === 'unknown') throw new EngramUnknownOutcomeError()
      if (outcome === 'failed') throw new Error('definite HTTP refusal')
      return { id: 7, status: 'saved' }
    }
    runtime.compaction.event(session, event('c', 'private summary {{unknown}} <private>secret</private>'))
    await runtime.queue.drain(host.id, 100)
    runtime.compaction.clearDelivered(host.id)
    assert.equal(runtime.compaction.notice('other'), '')
    const notice = runtime.compaction.notice(host.id)
    assert.equal(notice, recoveryNotice(outcome)); assert.equal(typeof notice, 'string')
    assert.ok(!notice.includes('{{')); assert.ok(!notice.includes('private summary'))
    assert.equal(runtime.compaction.notice(host.id), notice, 'retained until turn stop')
    runtime.compaction.clearDelivered(host.id)
    assert.equal(runtime.compaction.notice(host.id), '')
    if (outcome !== 'unavailable') {
      assert.equal(written.topic_key, 'session/compaction-recovery')
      assert.equal(written.title, 'Compaction recovery summary')
      assert.equal(written.type, 'session_summary')
      assert.equal(written.content, 'private summary {{unknown}} [REDACTED]')
    }
  })
}
test('disposed compaction never leaves a late recovery notice', async () => {
  const runtime = new Runtime(config('http://127.0.0.1:1')), host = agent()
  let release
  const gate = new Promise(resolve => { release = resolve })
  runtime.prepare = async () => { await gate; throw new Error('disposed') }
  runtime.compaction.event({ id: host.id, header: host.session.header }, event())
  await new Promise(resolve => setImmediate(resolve))
  runtime.dispose(host.id); release()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(runtime.compaction.notice(host.id), '')
})
