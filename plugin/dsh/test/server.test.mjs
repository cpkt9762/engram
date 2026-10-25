import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile, readFile, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { stub, json, config, identity, home, contract } from './helpers.test.mjs'
import { Server, ownership, startupBackoffMs } from '../lib/server.ts'

async function binary() {
  const dir = await mkdtemp(join(home, 'bin-')), file = join(dir, 'engram'), record = join(dir, 'calls')
  await writeFile(file, `#!${process.execPath}
const fs = require('node:fs'), http = require('node:http');
fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify({args:process.argv.slice(2),port:process.env.ENGRAM_PORT})+'\\n');
if(process.argv[2]==='instance-id') { console.log('${identity}'); }
else {
 const server=http.createServer((req,res)=>{res.end(JSON.stringify(req.url==='/health'?{instance_id:'${identity}'}:req.url==='/runtime-contract'?${JSON.stringify(contract())}:{project:'recovery'})); setTimeout(()=>server.close(),500).unref();});
 server.listen(Number(process.env.ENGRAM_PORT),'127.0.0.1');
 setTimeout(()=>server.close(),2000).unref();
}
`, { mode: 0o700 })
  return { file, calls: async () => (await readFile(record, 'utf8')).trim().split('\n').map(JSON.parse) }
}
test('explicit URL never resolves identity or launches a binary', async () => {
  await new Server(config('http://127.0.0.1:1')).ensure()
})
test('ownership distinguishes ready, foreign, legacy and missing identity', () => {
  assert.equal(ownership({ instance_id: identity }, identity), 'ready')
  assert.equal(ownership({ instance_id: 'b'.repeat(32) }, identity), 'foreign')
  for (const version of ['1.9.0', '2.0.0-rc.10', '2.0.0-alpha.1']) assert.equal(ownership({ version }, identity), 'legacy')
  for (const version of [undefined, 'unknown', '2.0.0', '2.0.0-rc.11', '2.0.0-rc.01', '3.0.0']) assert.equal(ownership({ version }, identity), 'identity_missing')
})
for (const [state, health] of [['ready', { instance_id: identity }], ['foreign', { instance_id: 'b'.repeat(32) }], ['legacy', { version: '1.0.0' }], ['identity_missing', {}]]) {
  test(`implicit server ${state}: never adopts or spawns over existing service`, async t => {
    const { url } = await stub(t, (req, res) => json(res, health))
    const bin = await binary()
    const server = new Server({ ...config(undefined), port: Number(new URL(url).port), engramBin: bin.file })
    if (state === 'ready') await server.ensure()
    else await assert.rejects(server.ensure(), new RegExp(state))
    assert.deepEqual((await bin.calls()).map(c => c.args), [['instance-id']])
  })
}
test('only refused connection spawns serve with configured ENGRAM_PORT', async t => {
  const { url, server: placeholder } = await stub(t, () => {})
  const port = Number(new URL(url).port)
  await new Promise(resolve => placeholder.close(resolve))
  const bin = await binary()
  const server = new Server({ ...config(undefined), port, engramBin: bin.file })
  await Promise.all([server.ensure(), server.ensure()])
  const calls = await bin.calls()
  assert.deepEqual(calls.map(c => c.args), [['instance-id'], ['serve']])
  assert.equal(calls[1].port, String(port))
})
test('non-refused health failure never spawns and startup failure is single-flight with backoff', async t => {
  let requests = 0, now = 0
  const { url } = await stub(t, (req, res) => { requests++; json(res, {}, 503) })
  const bin = await binary()
  const server = new Server({ ...config(undefined), port: Number(new URL(url).port), engramBin: bin.file }, () => now)
  await Promise.all([assert.rejects(server.ensure()), assert.rejects(server.ensure())])
  await assert.rejects(server.ensure())
  assert.equal(requests, 1)
  now = 1001; await assert.rejects(server.ensure())
  assert.equal(requests, 2)
  assert.equal((await bin.calls()).length, 2)
  assert.deepEqual([1, 2, 8].map(startupBackoffMs), [1000, 2000, 60000])
})
test('missing binary and malformed identity fail before connecting', async () => {
  await assert.rejects(new Server(config(undefined)).ensure(), /instance-id failed/)
  const path = join(home, 'bad-engram')
  await writeFile(path, '#!/bin/sh\nprintf "invalid\\n"\n', { mode: 0o700 })
  await assert.rejects(new Server({ ...config(undefined), engramBin: path }).ensure(), /32 hexadecimal/)
})
test('runtime recovers a stopped implicit serve on next call without replaying this call', async t => {
  const { Runtime } = await import('../lib/runtime.ts')
  const { contract, agent } = await import('./helpers.test.mjs')
  const { EngramUnavailableError } = await import('../lib/client.ts')
  const { url, server: initial } = await stub(t, (req, res) => {
    res.setHeader('Connection', 'close')
    json(res, req.url === '/health' ? { instance_id: identity } : req.url === '/runtime-contract' ? contract() : { project: 'recovery' })
  })
  const port = Number(new URL(url).port)
  const bin = await binary()
  const runtime = new Runtime({ ...config(undefined), port, engramBin: bin.file })
  await runtime.prepare(agent())
  await new Promise(resolve => { initial.closeAllConnections(); initial.close(resolve) })
  await assert.rejects(runtime.prepare(agent()), EngramUnavailableError)
  assert.equal((await bin.calls()).length, 1)
  assert.equal((await runtime.prepare(agent())).project, 'recovery')
  const calls = await bin.calls()
  assert.deepEqual(calls.map(c => c.args), [['instance-id'], ['instance-id'], ['serve']])
  assert.equal(calls.at(-1).port, String(port))
})
test('explicit URL stays unavailable without executing its configured binary', async t => {
  const { Runtime } = await import('../lib/runtime.ts')
  const { contract, agent } = await import('./helpers.test.mjs')
  const { EngramUnavailableError } = await import('../lib/client.ts')
  const { url, server: initial } = await stub(t, (req, res) => {
    res.setHeader('Connection', 'close')
    json(res, req.url === '/runtime-contract' ? contract() : { project: 'remote' })
  })
  const runtime = new Runtime(config(url))
  await runtime.prepare(agent())
  await new Promise(resolve => { initial.closeAllConnections(); initial.close(resolve) })
  await assert.rejects(runtime.prepare(agent()), EngramUnavailableError)
  await assert.rejects(runtime.prepare(agent()), EngramUnavailableError)
  assert.equal(runtime.server.localId, undefined)
})
