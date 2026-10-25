import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { stub, json, config, contract, identity } from './helpers.test.mjs'
import { Client } from '../lib/client.ts'
import { Contract, runtimeContractIdentity, RuntimeContractError } from '../lib/contract.ts'

test('contract bytes match Pi and lib-relative URL works from another cwd', async () => {
  assert.deepEqual(await readFile(new URL('../runtime-contract.json', import.meta.url)), await readFile(new URL('../../pi/runtime-contract.json', import.meta.url)))
  assert.equal(runtimeContractIdentity(contract()), identity)
  for (const value of [null, [], {}, { ...contract(), instance_id: '' }, { ...contract(), instance_id: 'x'.repeat(129) }, { ...contract(), revision: 123 }, { ...contract(), extra: true }]) assert.throws(() => runtimeContractIdentity(value), RuntimeContractError)
})
test('all DSH imports are type-only, runtime only imports builtins and relative TypeScript', async () => {
  const paths = [new URL('../index.ts', import.meta.url), ...(await readdir(new URL('../lib/', import.meta.url))).filter(p => p.endsWith('.ts')).map(p => new URL(`../lib/${p}`, import.meta.url))]
  for (const path of paths) {
    const text = await readFile(path, 'utf8')
    for (const line of text.split('\n').filter(line => /@deepseek-ai\//.test(line))) assert.match(line, /^import type\b/, `${path}: ${line}`)
    for (const match of text.matchAll(/from ['"]([^'"]+)['"]/g)) assert.ok(match[1].startsWith('node:') || match[1].startsWith('@deepseek-ai/') || /^\..*\.ts$/.test(match[1]), match[1])
    assert.doesNotMatch(text, /process\.cwd\(/)
  }
})
test('contract validates identity, rejects mismatch and binding changes', async t => {
  let current = contract()
  const { url } = await stub(t, (req, res) => json(res, current))
  const validator = new Contract(new Client(config(url)), () => identity)
  await validator.check()
  current = { ...contract(), instance_id: 'b'.repeat(32) }
  await assert.rejects(validator.check(), /local instance mismatch/)
  const remote = new Contract(new Client(config(url)))
  await remote.check()
  current = contract()
  await assert.rejects(remote.check(), /identity changed; restart DSH/)
  current = { ...contract(), revision: 99 }
  await assert.rejects(new Contract(new Client(config(url))).check(), /projection mismatch/)
})
test('contract bounded response, unavailable endpoint and malformed JSON fail closed', async t => {
  let mode = 'large'
  const { url } = await stub(t, (req, res) => {
    if (mode === 'large') res.end('x'.repeat(65537))
    else if (mode === 'missing') json(res, {}, 404)
    else res.end('{')
  })
  const validator = new Contract(new Client(config(url)))
  await assert.rejects(validator.check(), /64 KiB/)
  mode = 'missing'; await assert.rejects(validator.check(), RuntimeContractError)
  mode = 'json'; await assert.rejects(validator.check(), RuntimeContractError)
})
test('runtime checks contract before each dispatch and each transport retry', async t => {
  let probes = 0, calls = 0
  const { url } = await stub(t, (req, res) => {
    if (req.url === '/runtime-contract') { probes++; return json(res, probes < 3 ? contract() : { ...contract(), revision: 44 }) }
    calls++; req.socket.destroy()
  })
  const client = new Client(config(url), { backoffMs: 1 })
  const validator = new Contract(client)
  client.beforeDispatch = signal => validator.check(signal)
  await assert.rejects(client.request('/search'), RuntimeContractError)
  assert.equal(probes, 3); assert.equal(calls, 2)
})
test('contract probe times out within its three-second budget and honors cancellation', async t => {
  const { url } = await stub(t, () => {})
  const validator = new Contract(new Client(config(url)))
  const controller = new AbortController()
  controller.abort(new Error('cancel contract'))
  await assert.rejects(validator.check(controller.signal), /cancel contract/)
  await assert.rejects(validator.check(), RuntimeContractError)
})
test('contract connection refused is unavailable rather than incompatible', async t => {
  const { EngramUnavailableError } = await import('../lib/client.ts')
  const { url, server } = await stub(t, () => {})
  await new Promise(resolve => server.close(resolve))
  await assert.rejects(new Contract(new Client(config(url))).check(), EngramUnavailableError)
})
