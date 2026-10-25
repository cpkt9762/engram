import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stub, json, config, body } from './helpers.test.mjs'
import { Client, EngramHttpError, EngramUnknownOutcomeError } from '../lib/client.ts'
import { postObservationWithReplayRecovery } from '../lib/save-recovery.ts'
const miss = { code: 'observation_save_result_not_found', error: 'no committed result found for operation_id' }

test('lost acknowledgement resolves from authoritative ledger without replay', async t => {
  let posts = 0, guards = 0, operation
  const { url } = await stub(t, async (req, res) => {
    if (req.method === 'POST') { posts++; operation = (await body(req)).operation_id; req.socket.destroy() }
    else { assert.equal(new URL(req.url, 'http://local').searchParams.get('operation_id'), operation); json(res, { id: 7, status: 'committed' }) }
  })
  const client = new Client(config(url)); client.beforeDispatch = async () => { guards++ }
  assert.deepEqual(await postObservationWithReplayRecovery(client, { title: 'x' }), { id: 7, status: 'committed' })
  assert.equal(posts, 1); assert.equal(guards, 3)
})
test('typed miss permits exactly one identical redacted replay', async t => {
  const payload = { title: 'original', content: '<private>secret</private> public' }, bytes = [], methods = []
  const { url } = await stub(t, async (req, res) => {
    methods.push(req.method)
    if (req.method === 'GET') return json(res, miss, 404)
    let raw = ''; for await (const chunk of req) raw += chunk
    bytes.push(raw)
    if (bytes.length === 1) { payload.title = 'mutated'; req.socket.destroy() }
    else json(res, { id: 8, status: 'saved' }, 201)
  })
  assert.deepEqual(await postObservationWithReplayRecovery(new Client(config(url)), payload, undefined, { backoffMs: 1 }), { id: 8, status: 'saved' })
  assert.deepEqual(methods, ['POST', 'GET', 'POST']); assert.equal(bytes[0], bytes[1])
  assert.equal(JSON.parse(bytes[0]).title, 'original'); assert.ok(!bytes[0].includes('secret'))
})
for (const status of [409, 410]) test(`replay HTTP ${status} gets one final authoritative lookup`, async t => {
  let posts = 0, gets = 0
  const { url } = await stub(t, async (req, res) => {
    if (req.method === 'POST') { await body(req); posts++; if (posts === 1) req.socket.destroy(); else json(res, { error: 'ledger ambiguity' }, status) }
    else { gets++; json(res, gets === 1 ? miss : { id: 9, status: 'committed' }, gets === 1 ? 404 : 200) }
  })
  assert.equal((await postObservationWithReplayRecovery(new Client(config(url)), {}, undefined, { backoffMs: 1 })).id, 9)
  assert.equal(posts, 2); assert.equal(gets, 2)
})
test('unresolved recovery remains unknown and does not expose UUID in errors or logs', async t => {
  let posts = 0, gets = 0, operation
  const { url } = await stub(t, async (req, res) => {
    if (req.method === 'POST') { operation = (await body(req)).operation_id; posts++; req.socket.destroy() }
    else { gets++; if (gets === 1) json(res, miss, 404); else req.socket.destroy() }
  })
  let failure
  try { await postObservationWithReplayRecovery(new Client(config(url)), {}, undefined, { backoffMs: 1 }) } catch (error) { failure = error }
  assert.ok(failure instanceof EngramUnknownOutcomeError)
  assert.ok(!failure.message.includes(operation))
  const { Diagnostics } = await import('../lib/diagnostics.ts'), logs = []
  new Diagnostics({ error: (...args) => logs.push(args), warn: (...args) => logs.push(args) }, '').report('save', failure)
  assert.ok(!JSON.stringify(logs).includes(operation)); assert.equal(posts, 2); assert.equal(gets, 2)
})
test('first HTTP failure stays typed and never replays or leaks echoed UUID', async t => {
  let requests = 0, operation
  const { url } = await stub(t, async (req, res) => {
    requests++; operation = (await body(req)).operation_id
    json(res, { error: `rejected ${operation}`, code: 'invalid_arguments' }, 400)
  })
  await assert.rejects(postObservationWithReplayRecovery(new Client(config(url)), {}), e => e instanceof EngramHttpError && e.status === 400 && e.code === 'invalid_arguments' && !e.message.includes(operation) && !JSON.stringify(e.data).includes(operation))
  assert.equal(requests, 1)
})
test('untyped misses and noncommitted lookup receipts never authorize replay or success', async t => {
  for (const response of [{ status: 404, data: { error: 'not found' } }, { status: 200, data: { id: 1, status: 'saved' } }]) {
    let posts = 0
    const { url } = await stub(t, (req, res) => { if (req.method === 'POST') { posts++; req.socket.destroy() } else json(res, response.data, response.status) })
    await assert.rejects(postObservationWithReplayRecovery(new Client(config(url)), {}), EngramUnknownOutcomeError)
    assert.equal(posts, 1)
  }
})
test('caller cancellation before dispatch, during exchange and during backoff is propagated', async t => {
  const pre = new AbortController(); pre.abort(new Error('before save'))
  await assert.rejects(postObservationWithReplayRecovery(new Client(config('http://127.0.0.1:1')), {}, pre.signal), /before save/)
  for (const backoff of [false, true]) {
    const controller = new AbortController(); let posts = 0
    const { url } = await stub(t, async (req, res) => {
      if (req.method === 'POST') { posts++; await body(req); if (!backoff) controller.abort(new Error('cancel exchange')); else req.socket.destroy() }
      else { json(res, miss, 404); setTimeout(() => controller.abort(new Error('cancel backoff')), 10) }
    })
    await assert.rejects(postObservationWithReplayRecovery(new Client(config(url)), {}, controller.signal), backoff ? /cancel backoff/ : /cancel exchange/)
    assert.equal(posts, 1)
  }
})
test('total deadline is bounded and qualification or binding changes block recovery dispatch', async t => {
  const { url } = await stub(t, () => {})
  await assert.rejects(postObservationWithReplayRecovery(new Client(config(url)), {}, undefined, { totalMs: 50, postMs: 20, getMs: 20 }), EngramUnknownOutcomeError)
  let identity = 'a', posts = 0, gets = 0
  const other = await stub(t, (req, res) => { if (req.method === 'POST') { posts++; identity = 'b'; req.socket.destroy() } else { gets++; json(res, { id: 3, status: 'committed' }) } })
  const client = new Client(config(other.url)); client.binding = () => identity
  await assert.rejects(postObservationWithReplayRecovery(client, {}), EngramUnknownOutcomeError)
  assert.equal(posts, 1); assert.equal(gets, 0)
})
