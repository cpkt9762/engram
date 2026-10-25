import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, inject } from '../index.ts'
import { stub, json, contract, agent, home, body, fakeContext, projection } from './helpers.test.mjs'
import { redactPrivateTags, redactUrlPath, redactValue } from '../lib/redaction.ts'

async function harness(t, options = {}) {
  const seen = [], h = fakeContext()
  const { url } = await stub(t, async (req, res) => {
    if (req.url === '/runtime-contract') return json(res, contract())
    if (req.url.startsWith('/project/current')) return json(res, { project: options.project ?? 'current', project_source: 'config' })
    if (req.url === '/health') return json(res, { capabilities: { root_session_resume: true } })
    const data = ['POST', 'PATCH'].includes(req.method) ? await body(req) : undefined
    seen.push({ path: req.url, data })
    if (req.url === '/sessions') return json(res, { id: options.effectiveId ?? data.id, status: 'created' })
    json(res, { id: seen.length, status: 'saved' }, 201)
  })
  apply(h.ctx, { url })
  return { ...h, seen, tools: Object.fromEntries(h.tools.map(t => [t.name, t])), host: agent() }
}
const user = text => ({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
const result = text => ({ content: [{ type: 'text', text }] })

test('protocol and recovery register globally with fixed placement and no initial history', () => {
  const h = fakeContext()
  apply(h.ctx, { url: 'http://127.0.0.1:1' })
  assert.deepEqual(inject, ['tools', 'systemPrompt'])
  assert.equal(h.sections.length, 1); assert.equal(h.contexts.length, 1)
  assert.equal(h.sections[0].name, 'engram-dsh:memory-protocol')
  assert.equal(h.sections[0].order, 9950); assert.equal(h.sections[0].interpolate, false)
  assert.equal(typeof h.sections[0].text, 'string')
  assert.match(h.sections[0].text, /The agent MUST follow this protocol without waiting for activation/)
  assert.doesNotMatch(h.sections[0].text, /ToolSearch|Pi-native|current Pi host/)
  assert.equal(h.contexts[0].name, 'engram-dsh:compaction-recovery'); assert.equal(h.contexts[0].order, 130)
  assert.equal(h.contexts[0].text({ agent: agent() }), '')
})
test('private blocks redact recursively and inside encoded query values', () => {
  assert.equal(redactPrivateTags('public <PRIVATE>secret\nbody</PRIVATE> end'), 'public [REDACTED] end')
  assert.deepEqual(redactValue({ a: ['<private>secret</private>', 1, null] }), { a: ['[REDACTED]', 1, null] })
  assert.equal(new URL(redactUrlPath('/search?q=%3Cprivate%3Esecret%3C%2Fprivate%3E'), 'http://local').searchParams.get('q'), '[REDACTED]')
  const source = JSON.parse('{"__proto__":{"polluted":"no"}}')
  const copied = redactValue(source)
  assert.equal(Object.getPrototypeOf(copied), Object.prototype); assert.equal({}.polluted, undefined)
})
test('inbox only queues user text, redacts before truncating and skips subagents and short text', async t => {
  const h = await harness(t)
  for (const message of [user('short'), user('1234567890'), { source: { kind: 'extension' }, content: [{ type: 'text', text: 'long synthetic prompt here' }] }, { source: { kind: 'user' }, content: [{ type: 'image', text: 'ignore this non-text block' }] }]) assert.equal(h.events['agent/inbox/inserted']({ agent: h.host, message }), undefined)
  for (const header of [{ cwd: home, origin: 'subagent' }, { cwd: home, delegationDepth: 1 }]) h.events['agent/inbox/inserted']({ agent: { ...h.host, session: { header } }, message: user('child user text is not human input') })
  const text = 'public prompt '.repeat(140) + '<private>' + 'secret'.repeat(100) + '</private>' + ' tail '.repeat(100)
  h.events['agent/inbox/inserted']({ agent: h.host, message: user(text) })
  assert.equal(h.seen.length, 0, 'listener must only enqueue')
  await h.events['agent/turn-stopping']({ agent: h.host })
  const prompts = h.seen.filter(r => r.path === '/prompts')
  assert.equal(prompts.length, 1)
  assert.equal(prompts[0].data.content.length, 2000)
  assert.ok(!prompts[0].data.content.includes('secret'))
  assert.match(prompts[0].data.content, /\[REDACTED\]/)
  assert.equal(prompts[0].data.session_id, h.host.id)
  assert.deepEqual(prompts[0].data.project_provenance, { source: 'config', directory: home })
})
test('mem_save carries only the matching turn, project and effective session current_prompt', async t => {
  const h = await harness(t), exec = { agent: h.host }
  const content = 'current prompt for one explicit isolated save'
  h.events['agent/inbox/inserted']({ agent: h.host, message: user(content) })
  await h.tools.mem_save.execute({ title: 'one', content: 'one body' }, exec)
  assert.deepEqual(h.seen.filter(r => ['/prompts', '/observations'].includes(r.path)).map(r => r.path), ['/prompts', '/observations'])
  assert.equal(h.seen.at(-1).data.current_prompt, content)
  await h.tools.mem_save.execute({ title: 'opt out', content: 'no current prompt', capture_prompt: false }, exec)
  assert.equal(h.seen.at(-1).data.current_prompt, undefined)
  await h.tools.mem_save.execute({ title: 'other', content: 'other agent' }, { agent: agent('other') })
  assert.equal(h.seen.at(-1).data.current_prompt, undefined)
  await h.events['agent/turn-stopping']({ agent: h.host })
  await h.tools.mem_save.execute({ title: 'later', content: 'later turn' }, exec)
  assert.equal(h.seen.at(-1).data.current_prompt, undefined)
  h.events['agent/inbox/inserted']({ agent: h.host, message: user('prior prompt must not leak into a short input') })
  h.events['agent/inbox/inserted']({ agent: h.host, message: user('short') })
  await h.tools.mem_save.execute({ title: 'short', content: 'short input turn' }, exec)
  assert.equal(h.seen.at(-1).data.current_prompt, undefined)
})
test('tools/result skip rules and raw eligible text go to Go without local learnings filtering', async t => {
  const h = await harness(t), long = 'plain output with no Key Learnings heading '.repeat(3)
  for (const name of Object.keys(projection.operations)) h.events['tools/result']({ name, agent: h.host }, result(long))
  for (const exec of [{ name: 'read' }, { name: 'read', parent: {}, agent: h.host }, { name: 'read', agent: { ...h.host, session: { header: { cwd: home, origin: 'subagent' } } } }, { name: 'read', agent: { ...h.host, session: { header: { cwd: home, delegationDepth: 1 } } } }]) h.events['tools/result'](exec, result(long))
  h.events['tools/result']({ name: 'read', agent: h.host }, { ...result(long), isError: true })
  h.events['tools/result']({ name: 'read', agent: h.host }, result('x'.repeat(50)))
  h.events['tools/result']({ name: 'read', agent: h.host }, result('<private>' + 'hidden'.repeat(100) + '</private>'))
  assert.equal(h.events['tools/result']({ name: 'read', agent: h.host }, result(long + '<private>private tool detail</private>')), undefined)
  assert.equal(h.seen.length, 0)
  await h.events['agent/turn-stopping']({ agent: h.host })
  const passive = h.seen.filter(r => r.path === '/observations/passive')
  assert.equal(passive.length, 1); assert.equal(passive[0].data.content, long + '[REDACTED]')
  assert.ok(!JSON.stringify(passive[0].data).includes('private tool detail'))
  assert.equal(passive[0].data.source, 'read')
})
test('project failure logs and skips capture without registering or writing', async t => {
  const h = await harness(t, { project: 'unknown' })
  h.events['agent/inbox/inserted']({ agent: h.host, message: user('must not be captured under an unknown project') })
  await h.events['agent/turn-stopping']({ agent: h.host })
  assert.equal(h.seen.length, 0); assert.ok(h.logs.some(row => /project resolution/.test(JSON.stringify(row))))
})
test('all lifecycle listeners tolerate malformed input and logger failures', async () => {
  const h = fakeContext()
  h.ctx.logger = () => ({ warn() { throw new Error('logger unavailable') } })
  apply(h.ctx, { url: 'http://127.0.0.1:1' })
  for (const [name, listener] of Object.entries(h.events)) {
    assert.doesNotThrow(() => listener(undefined, undefined), name)
    await listener(undefined, undefined)
  }
  for (const dispose of h.disposers) dispose()
})
test('session/event recovery remains pending until delivered to its agent, then turn-stop clears it', async t => {
  const h = await harness(t), session = { id: h.host.id, header: h.host.session.header }
  const event = { type: 'compaction/summary', data: { compactionId: 'one', summary: [{ type: 'text', text: 'a verified compacted summary with {{untrusted}} data' }] } }
  assert.equal(h.events['session/event'](session, event), undefined)
  h.events['session/event'](session, event)
  await h.events['agent/turn-stopping']({ agent: h.host })
  assert.equal(h.seen.filter(r => r.path === '/observations').length, 1)
  const provider = h.contexts[0].text
  assert.equal(provider({ agent: agent('other') }), '')
  const notice = provider({ agent: h.host })
  assert.match(notice, /already saved/); assert.ok(!notice.includes('{{'))
  assert.equal(provider({ agent: h.host }), notice)
  await h.events['agent/turn-stopping']({ agent: h.host })
  assert.equal(provider({ agent: h.host }), '')
})
test('agent/disposed drops queued work and logs the discard without ending the server session', async t => {
  const h = await harness(t)
  h.events['agent/inbox/inserted']({ agent: h.host, message: user('this pending prompt must never start after disposal') })
  h.events['tools/result']({ name: 'read', agent: h.host }, result('pending output that must be discarded before dispatch '.repeat(2)))
  assert.equal(h.events['agent/disposed']({ agent: h.host }), undefined)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(h.seen.length, 0)
  assert.ok(h.logs.some(row => /discarded 2/.test(JSON.stringify(row))))
})
