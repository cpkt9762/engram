import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stub, json, config } from './helpers.test.mjs'
import { Client, EngramHttpError, EngramUnavailableError, EngramUnknownOutcomeError, fetchPolicy } from '../lib/client.ts'

test('fetch policies match Pi timeout and retry budgets', () => {
  assert.deepEqual(fetchPolicy('/x', 'GET'), { timeoutMs: 10000, maxAttempts: 3, write: false })
  assert.equal(fetchPolicy('/doctor', 'GET').timeoutMs, 15000)
  assert.deepEqual(fetchPolicy('/sessions', 'POST'), { timeoutMs: 5000, maxAttempts: 2, write: true })
  assert.deepEqual(fetchPolicy('/observations', 'POST'), { timeoutMs: 3000, maxAttempts: 1, write: true })
})
for (const [method, path, count] of [['GET', '/x', 3], ['POST', '/sessions', 2], ['POST', '/observations', 1]]) {
  test(`${method} ${path} transport retry count ${count} and qualification before every attempt`, async t => {
    let calls = 0, guards = 0
    const { url } = await stub(t, (req, res) => { calls++; req.socket.destroy() })
    const client = new Client(config(url), { backoffMs: 1 })
    client.beforeDispatch = async () => { guards++ }
    await assert.rejects(client.request(path, { method }), method === 'POST' ? EngramUnknownOutcomeError : /failed/)
    assert.equal(calls, count); assert.equal(guards, count)
  })
}
test('timeouts retry reads but never retry observation writes', async t => {
  let calls = 0
  const { url } = await stub(t, () => { calls++ })
  const client = new Client(config(url), { timeoutMs: 30, backoffMs: 1 })
  await assert.rejects(client.request('/x'), /timed out/)
  assert.equal(calls, 3)
  await assert.rejects(client.request('/observations', { method: 'POST', body: {} }), error => error instanceof EngramUnknownOutcomeError && /mem_search/.test(error.message))
  assert.equal(calls, 4)
})
test('definite refused connection is classified separately', async t => {
  const { url, server } = await stub(t, () => {})
  await new Promise(resolve => server.close(resolve))
  await assert.rejects(new Client(config(url), { backoffMs: 1 }).request('/x'), EngramUnavailableError)
})
test('HTTP errors preserve status and code without retry; bearer excludes health', async t => {
  const seen = []
  const { url } = await stub(t, (req, res) => { seen.push([req.url, req.headers.authorization]); json(res, { error: 'denied', code: 'denied' }, 409) })
  const client = new Client({ ...config(url), token: 'test-only-placeholder' })
  for (const path of ['/health', '/search']) await assert.rejects(client.request(path), e => e instanceof EngramHttpError && e.status === 409 && e.code === 'denied' && e.message === 'denied')
  assert.deepEqual(seen, [['/health', undefined], ['/search', 'Bearer test-only-placeholder']])
})
test('caller cancellation blocks dispatch and interrupts read backoff', async t => {
  let calls = 0
  const { url } = await stub(t, req => { calls++; req.socket.destroy() })
  const controller = new AbortController()
  controller.abort(new Error('cancelled'))
  const client = new Client(config(url))
  await assert.rejects(client.request('/x', { signal: controller.signal }), /cancelled/)
  assert.equal(calls, 0)
  const second = new AbortController()
  setTimeout(() => second.abort(new Error('cancel backoff')), 30)
  await assert.rejects(client.request('/x', { signal: second.signal }), /cancel backoff/)
  assert.equal(calls, 1)
})
test('qualification failures and HTTP failures are never retried', async () => {
  let guards = 0, dispatches = 0
  const client = new Client(config('http://127.0.0.1:1'), { fetch: async () => { dispatches++; return new Response('{}') } })
  client.beforeDispatch = async () => { guards++; throw new Error('contract mismatch') }
  await assert.rejects(client.request('/x'), /contract mismatch/)
  assert.equal(guards, 1); assert.equal(dispatches, 0)
})
test('truncated write acknowledgement is unknown, successful JSON null is valid', async t => {
  const { url } = await stub(t, (req, res) => { res.end(req.url === '/null' ? 'null' : '{') })
  const client = new Client(config(url))
  await assert.rejects(client.request('/observations', { method: 'POST' }), EngramUnknownOutcomeError)
  await assert.rejects(client.request('/bad'), SyntaxError)
  assert.equal(await client.request('/null'), null)
})
test('unknown session registration acknowledgement stays unknown even after a refused retry', async () => {
  let attempts = 0
  const client = new Client(config('http://127.0.0.1:1'), { backoffMs: 1, fetch: async () => {
    attempts++
    if (attempts === 1) throw new TypeError('socket closed after dispatch')
    throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })
  } })
  await assert.rejects(client.request('/sessions', { method: 'POST' }), EngramUnknownOutcomeError)
  assert.equal(attempts, 2)
})
test('definite refused write reports unavailable once without replay and notifies runtime recovery', async t => {
  const { url, server } = await stub(t, () => {})
  await new Promise(resolve => server.close(resolve))
  const client = new Client(config(url))
  let resets = 0
  client.onUnavailable = () => { resets++ }
  await assert.rejects(client.request('/observations', { method: 'POST', body: {} }), EngramUnavailableError)
  assert.equal(resets, 1)
})
