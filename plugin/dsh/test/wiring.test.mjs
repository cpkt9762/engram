import { projection } from './helpers.test.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../index.ts'

test('apply registers exactly the 23 contract operations and warmup is synchronous and failure-safe', async () => {
  const tools = [], events = {}, logs = []
  apply({ systemPrompt: { section() {}, context() {} }, effect() {}, tools: { register: tool => tools.push(tool) }, on: (name, fn) => { events[name] = fn }, logger: () => ({ warn: (...args) => logs.push(args), error: (...args) => logs.push(args) }) }, { url: 'http://127.0.0.1:1' })
  assert.deepEqual(tools.map(t => t.name).sort(), Object.keys(projection.operations).sort())
  assert.equal(events['agent/created']({ agent: { id: 'a', session: { header: { cwd: '/tmp' } } } }), undefined)
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(logs.length, 1)
  assert.equal(events['agent/disposed']({ agent: { id: 'a' } }), undefined)
})

test('duplicate registration fails synchronously and invalid configuration registers nothing', () => {
  const duplicate = { tools: { register() { throw new Error('duplicate tool') } }, logger: () => ({}), on() {} }
  assert.throws(() => apply(duplicate, { url: 'http://127.0.0.1:1' }), /duplicate tool/)
  let calls = 0
  assert.throws(() => apply({ systemPrompt: { section() {}, context() {} }, effect() {}, tools: { register() { calls++ } } }, { port: 'bad' }), /port/)
  assert.equal(calls, 0)
})
test('warmup logs a diagnostic reason and never logs the HTTP bearer', async t => {
  const { stub, json, contract, agent } = await import('./helpers.test.mjs')
  const token = 'test-bearer-not-in-logs', events = {}, logs = []
  const old = process.env.ENGRAM_HTTP_TOKEN
  process.env.ENGRAM_HTTP_TOKEN = token
  t.after(() => { if (old === undefined) delete process.env.ENGRAM_HTTP_TOKEN; else process.env.ENGRAM_HTTP_TOKEN = old })
  const { url } = await stub(t, (req, res) => json(res, { ...contract(), revision: 999 }))
  apply({ systemPrompt: { section() {}, context() {} }, effect() {}, tools: { register() {} }, on: (name, listener) => { events[name] = listener }, logger: () => ({ warn: (...args) => logs.push(args), error: (...args) => logs.push(args) }) }, { url })
  assert.equal(events['agent/created']({ agent: agent() }), undefined)
  for (let i = 0; logs.length === 0 && i < 50; i++) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(logs[0][0], 'Engram runtime qualification failed: %s')
  assert.match(logs[0][1], /projection mismatch/)
  assert.ok(!JSON.stringify(logs).includes(token))
})
