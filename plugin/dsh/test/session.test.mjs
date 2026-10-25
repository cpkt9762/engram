import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stub, json, config, body, home } from './helpers.test.mjs'
import { Client, EngramUnknownOutcomeError } from '../lib/client.ts'
import { Sessions, SessionProjectConflictError } from '../lib/session.ts'
const project = { cwd: home, project: 'p', provenance: { source: 'config', directory: home }, response: {} }

test('lazy registration adopts server resume id and caches until 60 seconds; invalidate re-registers', async t => {
  let registrations = 0, now = 0; const writes = []
  const { url } = await stub(t, async (req, res) => {
    if (req.url === '/health') return json(res, { capabilities: { root_session_resume: true } })
    const data = await body(req)
    if (req.url === '/sessions') {
      registrations++; assert.equal(data.resume, true); assert.equal(data.ownership_mode, 'project_owned')
      assert.deepEqual(data.project_provenance, project.provenance)
      return json(res, { id: `${data.id}:resume:${registrations}`, status: 'created' }, 201)
    }
    writes.push(data); json(res, { id: writes.length }, 201)
  })
  const sessions = new Sessions(new Client(config(url)), () => now)
  assert.equal(registrations, 0)
  await Promise.all([sessions.register('a', project), sessions.register('a', project)])
  await sessions.write('a', project, { title: 'first' })
  assert.equal(writes[0].session_id, 'a:resume:1'); assert.equal(registrations, 1)
  now = 60000; await sessions.write('a', project, {}); assert.equal(registrations, 1)
  now = 60001; await sessions.write('a', project, {}); assert.equal(writes.at(-1).session_id, 'a:resume:2')
  sessions.invalidate('a'); assert.equal(sessions.states.has('a'), false)
  await sessions.write('a', project, {}); assert.equal(registrations, 3)
  sessions.dispose('a'); assert.equal(sessions.states.has('a'), false)
})
test('missing resume capability blocks registration and writes', async t => {
  let calls = 0
  const { url } = await stub(t, (req, res) => { calls++; json(res, {}) })
  await assert.rejects(new Sessions(new Client(config(url))).write('a', project, {}), /root_session_resume/)
  assert.equal(calls, 1)
})
test('409 session_project_conflict is typed and no write follows', async t => {
  let writes = 0
  const { url } = await stub(t, (req, res) => {
    if (req.url === '/health') json(res, { capabilities: { root_session_resume: true } })
    else if (req.url === '/sessions') json(res, { code: 'session_project_conflict' }, 409)
    else { writes++; json(res, {}) }
  })
  await assert.rejects(new Sessions(new Client(config(url))).write('a', project, {}), SessionProjectConflictError)
  assert.equal(writes, 0)
})
for (const id of ['other', 'a:resume:', 'a:resume:0', 'a:resume:1garbage']) {
  test(`registration rejects invalid effective id ${id}`, async t => {
    const { url } = await stub(t, (req, res) => json(res, req.url === '/health' ? { capabilities: { root_session_resume: true } } : { id, status: 'created' }))
    await assert.rejects(new Sessions(new Client(config(url))).register('a', project), /acknowledgement/)
  })
}
test('unknown write outcome never re-registers or resends', async t => {
  let registrations = 0, writes = 0
  const { url } = await stub(t, async (req, res) => {
    if (req.url === '/health') return json(res, { capabilities: { root_session_resume: true } })
    if (req.url === '/sessions') { registrations++; return json(res, { id: 'a', status: 'created' }) }
    writes++; req.socket.destroy()
  })
  await assert.rejects(new Sessions(new Client(config(url))).write('a', project, {}), EngramUnknownOutcomeError)
  assert.equal(registrations, 1); assert.equal(writes, 1)
})
test('one agent cannot change project or cwd using cached registration', async t => {
  const { url } = await stub(t, (req, res) => json(res, req.url === '/health' ? { capabilities: { root_session_resume: true } } : { id: 'a', status: 'created' }))
  const sessions = new Sessions(new Client(config(url)))
  await sessions.register('a', project)
  await assert.rejects(sessions.register('a', { ...project, project: 'q' }), SessionProjectConflictError)
  await assert.rejects(sessions.register('a', { ...project, cwd: '/different' }), SessionProjectConflictError)
})
test('invalidate during registration prevents stale acknowledgement repopulating state', async t => {
  let release, started
  const arrived = new Promise(resolve => { started = resolve })
  const gate = new Promise(resolve => { release = resolve })
  const { url } = await stub(t, async (req, res) => {
    if (req.url === '/health') return json(res, { capabilities: { root_session_resume: true } })
    started(); await gate; json(res, { id: 'a', status: 'created' })
  })
  const sessions = new Sessions(new Client(config(url)))
  const pending = sessions.register('a', project)
  await arrived
  sessions.invalidate('a'); release()
  await assert.rejects(pending, /invalidated/)
  assert.equal(sessions.states.has('a'), false)
})
test('session close succeeds once, invalidates state, and uses the confirmed effective id', async t => {
  const seen = []
  const { url } = await stub(t, async (req, res) => {
    if (req.url === '/health') return json(res, { capabilities: { root_session_resume: true } })
    const data = await body(req); seen.push([req.url, data])
    if (req.url === '/sessions') return json(res, { id: 'a:resume:9', status: 'created' })
    assert.equal(req.url, '/sessions/a%3Aresume%3A9/end')
    json(res, { id: 'a:resume:9', status: 'completed' })
  })
  const sessions = new Sessions(new Client(config(url)))
  await sessions.end('a', project, 'done')
  assert.equal(sessions.states.has('a'), false)
  assert.deepEqual(seen.at(-1)[1], { summary: 'done', project_provenance: project.provenance })
})
test('unknown session end stays pinned until explicit retry and never automatically resends', async t => {
  let closes = 0, registrations = 0
  const { url } = await stub(t, async (req, res) => {
    if (req.url === '/health') return json(res, { capabilities: { root_session_resume: true } })
    await body(req)
    if (req.url === '/sessions') { registrations++; return json(res, { id: 'a', status: 'created' }) }
    closes++
    if (closes === 1) req.socket.destroy()
    else json(res, { id: 'a', status: 'completed' })
  })
  const sessions = new Sessions(new Client(config(url)))
  await assert.rejects(sessions.end('a', project), EngramUnknownOutcomeError)
  assert.equal(closes, 1)
  await assert.rejects(sessions.write('a', project, {}), /closing/)
  await sessions.end('a', project)
  assert.equal(closes, 2); assert.equal(registrations, 1)
})
test('confirmed finalization invalidates identity and allows registering a continuation', async t => {
  let registrations = 0
  const { url } = await stub(t, async (req, res) => {
    if (req.url === '/health') return json(res, { capabilities: { root_session_resume: true } })
    await body(req)
    if (req.url === '/sessions') { registrations++; return json(res, { id: registrations === 1 ? 'a' : 'a:resume:2', status: 'created' }) }
    if (req.url.endsWith('/finalize')) return json(res, { session_id: 'a', state: 'finalized', summary_id: 1, summary_sync_id: 'obs-1', already_finalized: false })
    json(res, { id: 2, status: 'saved' })
  })
  const sessions = new Sessions(new Client(config(url)))
  await sessions.finalize('a', project, 'summary')
  assert.equal(sessions.states.has('a'), false)
  await sessions.write('a', project, {})
  assert.equal(sessions.states.get('a').effectiveId, 'a:resume:2')
  assert.equal(registrations, 2)
})
test('malformed finalization acknowledgement remains unknown and blocks new writes', async t => {
  const { url } = await stub(t, (req, res) => json(res,
    req.url === '/health' ? { capabilities: { root_session_resume: true } }
      : req.url === '/sessions' ? { id: 'a', status: 'created' }
        : { state: 'finalized', session_id: 'other', summary_id: 1, summary_sync_id: 'obs-1', already_finalized: false }))
  const sessions = new Sessions(new Client(config(url)))
  await assert.rejects(sessions.finalize('a', project, 'summary'), /outcome is unknown/)
  await assert.rejects(sessions.write('a', project, {}), /closing or finalized/)
})
