import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stub, json, contract, projection, config, agent, body, toolArgs, home } from './helpers.test.mjs'
import { Runtime } from '../lib/runtime.ts'
import { createTools, validateArgs } from '../lib/tools.ts'
import { extraSchemas } from '../lib/tool-schemas.ts'
import { EngramHttpError, EngramUnknownOutcomeError } from '../lib/client.ts'

const cases = {
  mem_search_prompts: ['GET', '/prompts/search?q=q&project=current'],
  mem_get_observation: ['GET', '/observations/7?include_history=true&history_cursor=0'],
  mem_session_summary: ['POST', '/observations'], mem_update: ['PATCH', '/observations/7?expected_project=current'],
  mem_suggest_topic_key: ['POST', '/topic-keys/suggest'], mem_consolidate: ['POST', '/observations/consolidate'],
  mem_judge_many: ['POST', '/conflicts/judge-many'], mem_session_finalize: ['POST', '/sessions/test-agent%3Aresume%3A4/finalize'],
  mem_save_prompt: ['POST', '/prompts'], mem_session_start: ['POST', '/sessions'],
  mem_session_end: ['POST', '/sessions/test-agent%3Aresume%3A4/end'], mem_doctor: ['POST', '/doctor/caller-binding'],
  mem_capture_passive: ['POST', '/observations/passive'], mem_review: ['GET', '/review?project=current'],
  mem_judge: ['POST', '/conflicts/judge'], mem_compare: ['POST', '/conflicts/compare'],
  mem_list_projects: ['GET', '/projects'], mem_pin: ['PUT', '/observations/7/pin'], mem_unpin: ['DELETE', '/observations/7/pin'],
}
async function harness(t, override) {
  const seen = []
  const { url } = await stub(t, async (req, res) => {
    if (req.url === '/runtime-contract') return json(res, contract())
    if (req.url.startsWith('/project/current')) return json(res, { project: 'current', project_source: 'config' })
    if (req.url === '/health') return json(res, { capabilities: { root_session_resume: true } })
    const data = ['POST', 'PATCH'].includes(req.method) ? await body(req) : undefined
    seen.push({ method: req.method, path: req.url, data })
    if (override && await override(req, res, data)) return
    if (req.url === '/sessions') return json(res, { id: 'test-agent:resume:4', status: 'created' })
    if (req.url.endsWith('/finalize')) return json(res, { session_id: 'test-agent:resume:4', state: 'finalized', summary_id: 2, summary_sync_id: 'obs-2', already_finalized: false })
    if (req.url.endsWith('/end')) return json(res, { id: 'test-agent:resume:4', status: 'completed' })
    if (req.url === '/doctor/caller-binding') return json(res, { status: 'unknown', root_state: 'unknown', effective_state: 'unknown', reason_code: 'caller_context_missing', safe_next_step: 'Collect caller context without registering a session.', write_success_guaranteed: false })
    json(res, { id: 7, status: 'saved' })
  })
  const runtime = new Runtime(config(url)), exec = { agent: agent() }
  return { runtime, seen, exec, tools: Object.fromEntries(createTools(runtime).map(tool => [tool.name, tool])) }
}
test('registered tool names equal the entire generated contract operations set', () => {
  const names = createTools(new Runtime(config('http://127.0.0.1:1'))).map(t => t.name).sort()
  assert.equal(names.length, 23); assert.deepEqual(names, Object.keys(projection.operations).sort())
  assert.deepEqual(Object.keys(cases).sort(), Object.keys(extraSchemas).sort())
})
for (const [name, [method, path]] of Object.entries(cases)) {
  test(`${name}: validates arguments and preserves Pi route and body`, async t => {
    const h = await harness(t)
    assert.throws(() => validateArgs(name, '{}'), /invalid arguments/)
    assert.throws(() => validateArgs(name, { ...toolArgs[name], unsupported: true }), /unsupported is not supported/)
    for (const key of Object.keys(extraSchemas[name].properties)) assert.throws(() => validateArgs(name, { ...toolArgs[name], [key]: null }), /invalid arguments/)
    for (const required of extraSchemas[name].required) {
      const missing = { ...toolArgs[name] }; delete missing[required]
      assert.throws(() => validateArgs(name, missing), new RegExp(`${required} is required`))
    }
    const result = await h.tools[name].execute(toolArgs[name], h.exec)
    const call = h.seen.at(-1)
    assert.equal(call.method, method); assert.equal(call.path, path)
    const expectedBodies = {
      mem_session_summary: { title: 'Session summary', content: 'summary', type: 'session_summary', scope: 'project', session_id: 'test-agent:resume:4', project: 'current', project_provenance: { source: 'config', directory: home } },
      mem_update: { find: 'old', replace: 'new' }, mem_suggest_topic_key: toolArgs.mem_suggest_topic_key,
      mem_consolidate: toolArgs.mem_consolidate, mem_judge_many: toolArgs.mem_judge_many,
      mem_session_finalize: { project: 'current', summary: toolArgs.mem_session_finalize.summary },
      mem_save_prompt: { content: 'prompt', project: 'current', session_id: 'test-agent:resume:4', project_provenance: { source: 'config', directory: home } },
      mem_session_start: { id: 'test-agent', project: 'current', directory: home, ownership_mode: 'project_owned', resume: true, project_provenance: { source: 'config', directory: home } },
      mem_session_end: { summary: 'summary', project_provenance: { source: 'config', directory: home } },
      mem_doctor: { project: 'current', runtime_session_id: 'test-agent', host_context: { append_entry_available: false, branch_available: false } },
      mem_capture_passive: { content: toolArgs.mem_capture_passive.content, source: 'dsh-tool', project: 'current', session_id: 'test-agent:resume:4', project_provenance: { source: 'config', directory: home } },
      mem_judge: { ...toolArgs.mem_judge, session_id: 'test-agent' }, mem_compare: toolArgs.mem_compare,
    }
    assert.deepEqual(call.data, expectedBodies[name])
    if (name === 'mem_session_end') assert.equal(h.runtime.sessions.states.has('test-agent'), false)
    if (name === 'mem_save_prompt') assert.deepEqual(result, { prompt_id: 7, status: 'saved' })
    if (name === 'mem_session_start') assert.equal(result.id, 'test-agent:resume:4')
    if (name === 'mem_doctor') assert.equal(result.caller_binding.write_success_guaranteed, false)
  })
}
test('recursive validator checks arrays, nested fields, exact integers and bounds', () => {
  const args = toolArgs.mem_consolidate
  for (const ids of [[], [1], [1, 1], [1, 1.5], [0, 2], [Number.MAX_SAFE_INTEGER + 1, 2], ['1', 2]]) assert.throws(() => validateArgs('mem_consolidate', { ...args, ids_to_delete: ids }), /invalid arguments/)
  for (const judgments of [[], Array(33).fill(toolArgs.mem_judge_many.judgments[0]), ['bad'], [{ judgment_id: 'r' }], [{ judgment_id: 'r', relation: 'related', confidence: 2 }], [{ judgment_id: 'r', relation: 'related', extra: true }]]) assert.throws(() => validateArgs('mem_judge_many', { judgments }), /invalid arguments/)
  assert.throws(() => validateArgs('mem_search_prompts', { query: 'q', project: 'p', all_projects: true }), /cannot be combined/)
  assert.throws(() => validateArgs('mem_judge', { judgment_id: 'r', relation: 'invalid' }), /invalid arguments/)
  assert.throws(() => validateArgs('mem_compare', { ...toolArgs.mem_compare, confidence: -1 }), /invalid arguments/)
  assert.equal(validateArgs('mem_update', { id: 1, expected_project: 'p', find: 'old', replace: '' }).replace, '')
})
test('new tools reject foreign host ids and directory overrides', async t => {
  const h = await harness(t)
  for (const name of ['mem_session_start', 'mem_session_end']) await assert.rejects(h.tools[name].execute({ id: 'other' }, h.exec), /current DSH agent/)
  await assert.rejects(h.tools.mem_session_start.execute({ directory: '/other' }, h.exec), /session.header.cwd/)
  assert.equal(h.seen.length, 0)
})
test('end failure retains binding; success invalidates; finalize unknown pins identity and blocks new writes', async t => {
  let closing = 0
  const h = await harness(t, (req, res) => {
    if (req.url.endsWith('/end')) { json(res, { error: 'denied' }, 403); return true }
    if (req.url.endsWith('/finalize')) { closing++; req.socket.destroy(); return true }
  })
  await assert.rejects(h.tools.mem_session_end.execute({}, h.exec), EngramHttpError)
  assert.equal(h.runtime.sessions.states.get('test-agent').effectiveId, 'test-agent:resume:4')
  await assert.rejects(h.tools.mem_session_finalize.execute(toolArgs.mem_session_finalize, h.exec), EngramUnknownOutcomeError)
  await assert.rejects(h.tools.mem_save.execute(toolArgs.mem_save, h.exec), /closing/)
  await assert.rejects(h.tools.mem_session_finalize.execute(toolArgs.mem_session_finalize, h.exec), EngramUnknownOutcomeError)
  assert.equal(closing, 2)
  assert.equal(h.seen.filter(r => r.path === '/sessions').length, 1)
})
test('review mark and prompt all-projects use explicit scope; typed HTTP refusal stays intact', async t => {
  const h = await harness(t, (req, res) => {
    if (req.url === '/conflicts/judge') { json(res, { error: 'missing relation', code: 'not_found' }, 404); return true }
  })
  await h.tools.mem_review.execute({ action: 'mark_reviewed', id: 7 }, h.exec)
  assert.deepEqual(h.seen.at(-1), { method: 'POST', path: '/review/mark_reviewed?project=current', data: { observation_id: 7 } })
  await h.tools.mem_search_prompts.execute({ query: 'q', all_projects: true }, h.exec)
  assert.equal(h.seen.at(-1).path, '/prompts/search?q=q&all_projects=true')
  await assert.rejects(h.tools.mem_judge.execute(toolArgs.mem_judge, h.exec), e => e instanceof EngramHttpError && e.status === 404 && e.code === 'not_found' && e.message === 'missing relation')
})
test('review scope is explicit and global review cannot mark a record reviewed', async t => {
  const h = await harness(t)
  await h.tools.mem_review.execute({ action: 'list', all_projects: true }, h.exec)
  assert.equal(h.seen.at(-1).path, '/review?all_projects=true')
  await assert.rejects(h.tools.mem_review.execute({ action: 'mark_reviewed', id: 7, all_projects: true }, h.exec), /all_projects is only supported/)
})

test('mem_update keeps deletion replacements and omits orphaned replacement fields', async t => {
  const h = await harness(t, (req, res, data) => {
    if (req.method === 'PATCH' && Object.keys(data).length === 0) { json(res, { error: 'at least one field is required' }, 400); return true }
  })
  const base = { id: 7, expected_project: 'current' }
  const frozen = Object.freeze({ ...base, find: 'x', replace: '' })
  await h.tools.mem_update.execute(frozen, h.exec)
  assert.deepEqual(h.seen.at(-1).data, { find: 'x', replace: '' })
  assert.equal(frozen.replace, '')
  await h.tools.mem_update.execute({ ...base, find: '', replace: '', content: 'new' }, h.exec)
  assert.deepEqual(h.seen.at(-1).data, { content: 'new' })
  await assert.rejects(h.tools.mem_update.execute({ ...base, find: '', replace: 'y' }, h.exec), e => e instanceof EngramHttpError && e.message === 'at least one field is required')
  assert.deepEqual(h.seen.at(-1).data, {})
  assert.equal(Object.hasOwn(validateArgs('mem_update', { ...base, replace: 'y' }), 'replace'), false)
  assert.deepEqual(validateArgs('mem_update', { ...base, find: ' x ', replace: '  ' }), { ...base, find: ' x ', replace: '  ' })
})
