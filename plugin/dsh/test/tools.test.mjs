import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { stub, json, contract, config, agent, home, body, toolArgs } from './helpers.test.mjs'
import { parseConfig } from '../lib/config.ts'
import { Runtime } from '../lib/runtime.ts'
import { createTools, validateArgs } from '../lib/tools.ts'

test('configuration precedence, types, URL and binary patch marker', async () => {
  const parsed = parseConfig({ url: 'http://127.0.0.1:23456/', port: 12345, engramBin: '/fake' }, { ENGRAM_URL: 'http://127.0.0.1:2', ENGRAM_PORT: '2', ENGRAM_BIN: '/env', ENGRAM_HTTP_TOKEN: 'test-only-placeholder' })
  assert.equal(parsed.url, 'http://127.0.0.1:23456'); assert.equal(parsed.port, 12345); assert.equal(parsed.engramBin, '/fake')
  assert.equal(parsed.token, 'test-only-placeholder')
  assert.equal(parseConfig(undefined, {}).port, 7437)
  assert.equal(parseConfig(undefined, { ENGRAM_PORT: '12345' }).port, 12345)
  assert.equal(parseConfig(undefined, { ENGRAM_BIN: '/env' }).engramBin, '/env')
  for (const raw of [null, [], '', { url: 1 }, { url: 'file:///tmp' }, { url: 'http://user:pass@localhost' }, { url: 'http://localhost?token=no' }, { engramBin: false }, { port: '4' }, { port: 0 }, { port: 65536 }, { port: NaN }]) assert.throws(() => parseConfig(raw, {}))
  assert.throws(() => parseConfig(undefined, { ENGRAM_PORT: '12junk' }))
  assert.match(await readFile(new URL('../lib/config.ts', import.meta.url), 'utf8'), /^const ENGRAM_BIN = optionalEnvironmentValue\(process.env.ENGRAM_BIN\) \?\? "engram"$/m)
})
test('tool validation rejects strings, required fields, types, enums, unsupported fields and bad numbers', () => {
  for (const name of ['mem_save', 'mem_search', 'mem_context', 'mem_current_project']) for (const raw of ['{}', [], null]) assert.throws(() => validateArgs(name, raw), /^Error: invalid arguments:/)
  for (const [name, args] of [
    ['mem_save', {}], ['mem_search', {}], ['mem_save', { title: 'a', content: 2 }], ['mem_search', { query: 'q', all_projects: 'true' }],
    ['mem_search', { query: 'q', match_mode: 'either' }], ['mem_search', { query: 'q', response_format: 'full' }],
    ['mem_context', { max_bytes: 0 }], ['mem_context', { max_bytes: 1.5 }], ['mem_context', { scope: 'other' }],
    ['mem_search', { query: 'q', limit: Infinity }], ['mem_save', { title: ' ', content: 'x' }], ['mem_current_project', { unknown: true }],
  ]) assert.throws(() => validateArgs(name, args), /^Error: invalid arguments:/)
  assert.throws(() => validateArgs('mem_save', {}), /title is required; content is required/)
  assert.equal(validateArgs('mem_search', { query: 'a', match_mode: 'any' }).query, 'a')
})
test('tools route reads by project, all_projects explicitly opens scope, writes carry acknowledged identity and provenance', async t => {
  const requests = []
  const { url } = await stub(t, async (req, res) => {
    if (req.url === '/runtime-contract') return json(res, contract())
    if (req.url.startsWith('/project/current')) return json(res, { project: 'current', project_source: 'git', raw_project: 'raw' })
    if (req.url === '/health') return json(res, { capabilities: { root_session_resume: true } })
    const data = req.method === 'POST' ? await body(req) : undefined
    requests.push({ path: req.url, data })
    if (req.url === '/sessions') return json(res, { id: 'test-agent:resume:3', status: 'created' }, 201)
    json(res, { id: 1, status: 'saved' })
  })
  const runtime = new Runtime(config(url)), tools = Object.fromEntries(createTools(runtime).map(tool => [tool.name, tool]))
  const exec = { agent: agent(), signal: new AbortController().signal }
  assert.equal((await tools.mem_current_project.execute({}, exec)).project, 'current')
  assert.equal(requests.length, 0)
  await tools.mem_search.execute({ query: 'q', response_format: 'compact' }, exec)
  let params = new URL(requests.at(-1).path, url).searchParams
  assert.equal(params.get('project'), 'current'); assert.equal(params.get('q'), 'q'); assert.equal(params.get('response_format'), 'compact')
  await tools.mem_context.execute({ compact: true, older_history: true, max_bytes: 3000 }, exec)
  params = new URL(requests.at(-1).path, url).searchParams
  assert.equal(params.get('project'), 'current'); assert.equal(params.get('older_history'), 'true')
  for (const name of ['mem_search', 'mem_context']) {
    await tools[name].execute({ ...(name === 'mem_search' ? { query: 'q' } : {}), all_projects: true, project: 'ignored' }, exec)
    params = new URL(requests.at(-1).path, url).searchParams
    assert.equal(params.has('project'), false); assert.equal(params.get('all_projects'), 'true')
  }
  await tools.mem_save.execute({ title: 'title', content: 'content', capture_prompt: false }, exec)
  assert.equal(requests.at(-1).path, '/observations')
  assert.equal(requests.at(-1).data.session_id, 'test-agent:resume:3')
  assert.equal(requests.at(-1).data.project, 'current')
  assert.deepEqual(requests.at(-1).data.project_provenance, { source: 'git', directory: home, raw_project: 'raw' })
  assert.equal(requests.at(-1).data.capture_prompt, false)
  await assert.rejects(tools.mem_current_project.execute({ cwd: '/different' }, exec), /session.header.cwd/)
  await assert.rejects(tools.mem_search.execute({ query: 'q' }, {}), /exec.agent/)
  assert.deepEqual(tools.mem_save.output.render({}, { id: 1 }), [{ type: 'text', text: '{\n  "id": 1\n}' }])
})
test('unresolved project blocks all tools including writes before registration', async t => {
  let writes = 0
  const { url } = await stub(t, (req, res) => {
    if (req.url === '/runtime-contract') return json(res, contract())
    if (req.method === 'POST') writes++
    json(res, { project: 'unknown' })
  })
  for (const tool of createTools(new Runtime(config(url)))) {
    const args = toolArgs[tool.name]
    await assert.rejects(tool.execute(args, { agent: agent() }), /resolution failed/)
  }
  assert.equal(writes, 0)
})
test('blank optional strings are omitted without inventing search filters or write destinations', async t => {
  const seen = []
  const { url } = await stub(t, async (req, res) => {
    if (req.url === '/runtime-contract') return json(res, contract())
    if (req.url.startsWith('/project/current')) return json(res, { project: 'current' })
    if (req.url === '/health') return json(res, { capabilities: { root_session_resume: true } })
    const data = req.method === 'POST' ? await body(req) : undefined
    seen.push({ path: req.url, data })
    if (req.url === '/sessions') return json(res, { id: 'test-agent', status: 'created' })
    json(res, { id: 1, status: 'saved' })
  })
  const tools = Object.fromEntries(createTools(new Runtime(config(url))).map(tool => [tool.name, tool])), exec = { agent: agent() }
  const raw = Object.freeze({ query: 'q', type: '', scope: '  ', match_mode: '' })
  await tools.mem_search.execute(raw, exec)
  const query = new URL(seen.at(-1).path, url).searchParams
  assert.equal(query.has('type'), false); assert.equal(query.has('scope'), false); assert.equal(query.has('match_mode'), false)
  assert.equal(query.get('project'), 'current')
  assert.equal(raw.type, '', 'host arguments remain unchanged')
  await tools.mem_save.execute(Object.freeze({ title: 'title', content: 'body', cwd: '', project: '  ' }), exec)
  assert.equal(seen.at(-1).data.project, 'current')
  for (const [name, args] of [['mem_save', { title: '', content: 'x' }], ['mem_save', { title: 'x', content: ' ' }], ['mem_search', { query: '' }]]) assert.throws(() => validateArgs(name, args), /must not be blank/)
  const batch = Object.freeze({ judgments: Object.freeze([Object.freeze({ judgment_id: 'r', relation: 'related', reason: '', evidence: ' ' })]), session_id: '' })
  assert.deepEqual(validateArgs('mem_judge_many', batch), { judgments: [{ judgment_id: 'r', relation: 'related' }] })
})
