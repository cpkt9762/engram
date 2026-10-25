import { test } from 'node:test'
import assert from 'node:assert/strict'
import './helpers.test.mjs'
import { WriteQueues } from '../lib/queue.ts'

test('per-agent queue serializes work, isolates agents and survives a failed item', async () => {
  const logs = [], events = []
  const queues = new WriteQueues(message => logs.push(message))
  let release
  const gate = new Promise(resolve => { release = resolve })
  const first = queues.run('a', async () => { events.push('a1'); await gate; throw new Error('failed item') })
  const failed = assert.rejects(first, /failed item/)
  queues.enqueue('a', async () => { events.push('a2') })
  await queues.run('b', async () => { events.push('b1') })
  assert.deepEqual(events, ['a1', 'b1'])
  release(); await failed
  assert.equal(await queues.drain('a', 100), true)
  assert.deepEqual(events, ['a1', 'b1', 'a2'])
})
test('drain times out without blocking later work; dispose drops only unstarted items', async () => {
  const logs = [], queues = new WriteQueues(message => logs.push(message))
  let release, queued = false
  const gate = new Promise(resolve => { release = resolve })
  const active = queues.run('a', () => gate)
  const pending = queues.run('a', async () => { queued = true })
  const discarded = assert.rejects(pending, /disposed/)
  assert.equal(await queues.drain('a', 10), false)
  queues.dispose('a')
  await discarded
  release(); await active
  assert.equal(queued, false)
  assert.ok(logs.some(line => /timed out/.test(line)))
  assert.ok(logs.some(line => /discarded 1/.test(line)))
})
test('background failures are logged and cancellation removes waiting work', async () => {
  const logs = [], queues = new WriteQueues(message => logs.push(message))
  queues.enqueue('a', async () => { throw new Error('expected background failure') })
  assert.equal(await queues.drain('a', 100), true)
  assert.ok(logs.some(line => /expected background failure/.test(line)))
  let release, ran = false
  const active = queues.run('a', () => new Promise(resolve => { release = resolve }))
  const controller = new AbortController()
  const pending = queues.run('a', async () => { ran = true }, controller.signal)
  controller.abort(new Error('cancel waiting'))
  await assert.rejects(pending, /cancel waiting/)
  release(); await active
  assert.equal(ran, false)
})
