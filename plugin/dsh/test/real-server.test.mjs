import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { home, config, agent, fakeContext, startRealServer, lossySaveProxy } from './helpers.test.mjs'
import { Runtime } from '../lib/runtime.ts'
import { createTools } from '../lib/tools.ts'
import { EngramHttpError } from '../lib/client.ts'
import { apply } from '../index.ts'

test('real Go server: four tools, stable resume identity, ended root writes, renewal and invalidation', { timeout: 850000 }, async t => {
  const { url, stop } = await startRealServer()
  const projectDir = join(home, 'project')
  await mkdir(join(projectDir, '.engram'), { recursive: true })
  await writeFile(join(projectDir, '.engram/config.json'), JSON.stringify({ project_name: 'dsh-roundtrip' }))
  try {
    let now = 0
    const runtime = new Runtime(config(url), () => now)
    const tools = Object.fromEntries(createTools(runtime).map(tool => [tool.name, tool]))
    const host = agent('dsh-real-agent', projectDir), exec = { agent: host, signal: new AbortController().signal }
    const current = await tools.mem_current_project.execute({}, exec)
    assert.equal(current.project, 'dsh-roundtrip')
    await runtime.contract.check()
    console.log('real-server runtime contract: passed')
    const saved = await tools.mem_save.execute({ title: 'DSH roundtrip', content: 'dshroundtrip memory persisted by native DSH tools' }, exec)
    assert.ok(saved.id > 0)
    const found = await tools.mem_search.execute({ query: 'dshroundtrip' }, exec)
    assert.match(JSON.stringify(found), /dshroundtrip/)
    const unfiltered = await tools.mem_search.execute({ query: 'dshroundtrip', type: '' }, exec)
    assert.match(JSON.stringify(unfiltered), /dshroundtrip/)
    const context = await tools.mem_context.execute({}, exec)
    assert.match(context.context, /dshroundtrip/)
    const project = await runtime.prepare(host)
    const first = runtime.sessions.states.get(host.id).effectiveId
    assert.equal(first, host.id)
    const repeated = await runtime.sessions.register(host.id, project, undefined, true)
    assert.equal(repeated.effectiveId, first)
    console.log(`real-server stable effective id: ${first}`)
    const end = async id => {
      const res = await fetch(`${url}/sessions/${encodeURIComponent(id)}/end`, { method: 'POST', body: JSON.stringify({ summary: 'test end' }), headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(3000) })
      assert.equal(res.status, 200)
      await res.json()
    }
    const observation = async id => runtime.client.request(`/observations/${id}`)
    await end(first)
    let lastStatus
    runtime.client.options.fetch = async (...args) => {
      const res = await fetch(...args)
      if (String(args[0]).endsWith('/observations')) lastStatus = res.status
      return res
    }
    const within = await tools.mem_save.execute({ title: 'Within renewal window', content: 'dshwindow memory after external end before renewal' }, exec)
    assert.equal(lastStatus, 201)
    assert.equal((await observation(within.id)).session_id, first)
    console.log(`real-server ended-root write: HTTP ${lastStatus}, session_id=${first}`)
    now = 60001
    const renewed = await tools.mem_save.execute({ title: 'Renewed write', content: 'dshrenewed memory after renewal selects continuation' }, exec)
    const continuation = (await observation(renewed.id)).session_id
    assert.ok(continuation.startsWith(`${host.id}:resume:`)); assert.notEqual(continuation, first)
    console.log(`real-server renewed effective id: ${continuation}`)
    const secondHost = agent('dsh-invalidate-agent', projectDir), secondExec = { agent: secondHost }
    await tools.mem_save.execute({ title: 'Live invalidation', content: 'dshinvalidate live root' }, secondExec)
    runtime.sessions.invalidate(secondHost.id)
    const same = await tools.mem_save.execute({ title: 'Same live root', content: 'dshsame live root after invalidation' }, secondExec)
    assert.equal((await observation(same.id)).session_id, secondHost.id)
    await end(secondHost.id)
    runtime.sessions.invalidate(secondHost.id)
    const resumed = await tools.mem_save.execute({ title: 'Ended invalidation', content: 'dshended immediate invalidation continuation' }, secondExec)
    const resumedId = (await observation(resumed.id)).session_id
    assert.ok(resumedId.startsWith(`${secondHost.id}:resume:`)); assert.notEqual(resumedId, secondHost.id)
    console.log(`real-server invalidated effective id: ${resumedId}`)
    await t.test('P1b: all 19 operations succeed against the real Go server', async () => {
      const completed = new Set()
      const extended = { agent: agent('dsh-p1b-agent', projectDir) }
      const call = async (name, args = {}, caller = extended) => {
        const result = await tools[name].execute(args, caller)
        completed.add(name)
        console.log('real-server operation passed: ' + name)
        return result
      }
      const start = await call('mem_session_start')
      assert.equal(start.id, extended.agent.id); assert.equal(start.project, 'dsh-roundtrip')
      const prompt = await call('mem_save_prompt', { content: 'dshpromptunique remember the native adapter lifecycle' })
      assert.ok(prompt.prompt_id > 0)
      const prompts = await call('mem_search_prompts', { query: 'dshpromptunique' })
      assert.ok(Array.isArray(prompts)); assert.match(JSON.stringify(prompts), /dshpromptunique/)
      const summary = await call('mem_session_summary', { content: 'dshsummaryunique explicit session summary from the DSH tool' })
      assert.ok(summary.id > 0)
      const item = await call('mem_get_observation', { id: summary.id, include_history: true })
      assert.equal(item.type, 'session_summary')
      await call('mem_update', { id: summary.id, expected_project: 'dsh-roundtrip', content: 'dshupdatedunique updated summary content retained by Go' })
      const history = await call('mem_get_observation', { id: summary.id, include_history: true, history_cursor: 0 })
      assert.match(history.content, /dshupdatedunique/)
      assert.ok(history.version_count >= 1)
      await call('mem_update', { id: summary.id, expected_project: 'dsh-roundtrip', find: ' updated', replace: '' })
      const deleted = await call('mem_get_observation', { id: summary.id })
      assert.equal(deleted.content, 'dshupdatedunique summary content retained by Go')
      await call('mem_update', { id: summary.id, expected_project: 'dsh-roundtrip', find: '', replace: '', content: 'dshrewrittenunique new summary after empty pair' })
      assert.equal((await call('mem_get_observation', { id: summary.id })).content, 'dshrewrittenunique new summary after empty pair')
      await assert.rejects(tools.mem_update.execute({ id: summary.id, expected_project: 'dsh-roundtrip', find: '', replace: 'y' }, extended), e => e instanceof EngramHttpError && e.status === 400 && e.message === 'at least one field is required')
      console.log('real-server mem_update: empty replacement deletes text; empty pair permits content update; orphan replacement reports missing update fields')
      assert.equal((await call('mem_pin', { id: summary.id })).pinned, true)
      assert.equal((await call('mem_unpin', { id: summary.id })).pinned, false)
      const suggested = await call('mem_suggest_topic_key', { type: 'pattern', title: 'DSH lifecycle renewal', content: 'Native adapter sessions use server-issued continuation identities' })
      assert.ok(JSON.stringify(suggested).length > 2)
      const projects = await call('mem_list_projects')
      assert.ok(projects.projects.some(p => JSON.stringify(p).includes('dsh-roundtrip')))
      const doctor = await call('mem_doctor')
      assert.equal(doctor.caller_binding.write_success_guaranteed, false)
      assert.equal(doctor.caller_binding.root_state, 'active')
      const passive = await call('mem_capture_passive', { content: '## Key Learnings:\n- dshpassiveunique isolated native memory tools preserve explicit session ownership and deterministic continuation identities.' })
      assert.ok(passive.extracted > 0); assert.ok(passive.saved > 0)
      const captured = await tools.mem_search.execute({ query: 'dshpassiveunique' }, extended)
      assert.match(JSON.stringify(captured), /dshpassiveunique/)
      const review = await call('mem_review', { action: 'list' })
      assert.ok(Array.isArray(review.observations))
      assert.equal((await call('mem_review', { action: 'mark_reviewed', observation_id: summary.id })).id, summary.id)
      const related = await tools.mem_save.execute({ title: 'Memory relation source', content: 'dshrelationunique memory relation comparison uses authoritative Go identities' }, extended)
      const compared = await call('mem_compare', { memory_id_a: summary.id, memory_id_b: related.id, relation: 'related', confidence: 0.9, reasoning: 'The two fixtures describe adapter behavior from different perspectives', model: 'dsh-test-fixture' })
      assert.match(compared.sync_id, /^rel-/)
      const judged = await call('mem_judge', { judgment_id: compared.sync_id, relation: 'compatible', reason: 'Compatible fixture records', confidence: 0.9 })
      assert.equal(judged.relation.relation, 'compatible')
      const many = await call('mem_judge_many', { judgments: [{ judgment_id: compared.sync_id, relation: 'scoped', reason: 'Narrow fixture scope', confidence: 0.8 }], session_id: start.id })
      assert.equal(many.outcomes[0].status, 'success')
      const sourceA = await tools.mem_save.execute({ title: 'Consolidation source A', content: 'dshmergealpha isolated memory fixture source alpha' }, extended)
      const sourceB = await tools.mem_save.execute({ title: 'Consolidation source B', content: 'dshmergebeta isolated memory fixture source beta' }, extended)
      const merge = { ids_to_delete: [sourceA.id, sourceB.id], new_title: 'Merged fixture', new_content: 'dshmergedunique consolidated isolated fixture', expected_project: 'dsh-roundtrip' }
      const preview = await call('mem_consolidate', merge)
      assert.equal(preview.status, 'preview'); assert.ok(preview.plan.fingerprint)
      const merged = await call('mem_consolidate', { ...merge, confirm: true, fingerprint: preview.plan.fingerprint })
      assert.equal(merged.status, 'consolidated')
      const endTool = await call('mem_session_end', {})
      assert.equal(endTool.id, start.id)
      const afterEnd = await tools.mem_save.execute({ title: 'After native end', content: 'dshafterendunique native end invalidates cached effective identity' }, extended)
      const resumed = await tools.mem_get_observation.execute({ id: afterEnd.id }, extended)
      assert.ok(resumed.session_id.startsWith(start.id + ':resume:')); assert.notEqual(resumed.session_id, start.id)
      console.log('real-server P1b end-to-write effective id: ' + resumed.session_id)
      const finalizer = { agent: agent('dsh-p1b-finalize-agent', projectDir) }
      const finalArgs = { summary: '## Goal\nVerify atomic finalization.\n## Accomplished\nAll adapter tool paths exercised.' }
      const finalized = await call('mem_session_finalize', finalArgs, finalizer)
      assert.equal(finalized.state, 'finalized')
      const nextSave = await tools.mem_save.execute({ title: 'Continue after finalize', content: 'dshafterfinalizeunique resumed work after confirmed finalization' }, finalizer)
      const continued = await tools.mem_get_observation.execute({ id: nextSave.id }, finalizer)
      assert.ok(continued.session_id.startsWith(finalizer.agent.id + ':resume:'))
      assert.notEqual(continued.session_id, finalizer.agent.id)
      console.log('real-server after finalize effective id: ' + continued.session_id)
      assert.deepEqual([...completed].sort(), Object.keys(tools).filter(name => !['mem_current_project', 'mem_save', 'mem_search', 'mem_context'].includes(name)).sort())
      // Legacy judge/compare use HTTP status+message rather than a code field;
      // workflows preserve their Go code fields and per-item error envelopes.
      await assert.rejects(tools.mem_consolidate.execute({ ...merge, ids_to_delete: [900001, 900002] }, extended), e => e instanceof EngramHttpError && e.status === 400 && e.code === 'consolidation_refused')
      await assert.rejects(tools.mem_judge.execute({ judgment_id: 'rel-does-not-exist', relation: 'related' }, extended), e => e instanceof EngramHttpError && e.status === 400 && /not found/.test(e.message))
      await assert.rejects(tools.mem_compare.execute({ memory_id_a: 900001, memory_id_b: 900002, relation: 'related', confidence: 0.8, reasoning: 'Missing fixture identities' }, extended), e => e instanceof EngramHttpError && e.status === 404 && /not found/.test(e.message))
      const missingMany = await tools.mem_judge_many.execute({ judgments: [{ judgment_id: 'rel-does-not-exist', relation: 'related' }] }, extended)
      assert.equal(missingMany.outcomes[0].status, 'error'); assert.match(missingMany.outcomes[0].error, /not found/)
    })

    await t.test('P2: native inbox, current_prompt dedupe, tool capture and compaction recovery', async () => {
      const h = fakeContext(), host = agent('dsh-p2-agent', projectDir)
      host.session.id = host.id
      const originalFetch = globalThis.fetch, observations = []
      globalThis.fetch = async (input, options) => {
        if (String(input) === url + '/observations' && options?.body) observations.push(JSON.parse(options.body))
        return originalFetch(input, options)
      }
      try {
        apply(h.ctx, { url })
        const native = Object.fromEntries(h.tools.map(tool => [tool.name, tool]))
        const content = 'dshp2promptunique human request for native lifecycle capture <private>hidden prompt detail</private>'
        assert.equal(h.events['agent/inbox/inserted']({ agent: host, message: { source: { kind: 'user' }, content: [{ type: 'text', text: content }] } }), undefined)
        // The shared agent queue guarantees inbox POST /prompts precedes this save.
        const saved = await native.mem_save.execute({ title: 'After inbox capture', content: 'dshp2saveunique explicit native save with current prompt' }, { agent: host })
        assert.ok(saved.id > 0)
        assert.match(observations.at(-1).current_prompt, /dshp2promptunique/)
        assert.ok(!observations.at(-1).current_prompt.includes('hidden prompt detail'))
        const prompts = await native.mem_search_prompts.execute({ query: 'dshp2promptunique' }, { agent: host })
        assert.equal(prompts.length, 1, 'Go must dedupe lifecycle prompt plus current_prompt')
        assert.equal(prompts[0].session_id, host.id)
        const output = '## Key Learnings:\n- dshp2passiveunique native tool result capture preserves project ownership and delegates structured learning extraction to Go.'
        h.events['tools/result']({ name: 'read', agent: host }, { content: [{ type: 'text', text: output }], isError: false })
        const compacted = { type: 'compaction/summary', data: { compactionId: 'real-compaction-1', summary: [{ type: 'text', text: 'dshp2compactionunique archived summary for continued isolated adapter work {{untrusted}}' }] } }
        h.events['session/event'](host.session, compacted)
        h.events['session/event'](host.session, compacted)
        await h.events['agent/turn-stopping']({ agent: host })
        const passive = await native.mem_search.execute({ query: 'dshp2passiveunique' }, { agent: host })
        assert.ok(passive.length >= 1)
        const capturedObservation = await native.mem_get_observation.execute({ id: passive[0].id }, { agent: host })
        assert.equal(capturedObservation.tool_name, 'read')
        const archives = await native.mem_search.execute({ query: 'dshp2compactionunique' }, { agent: host })
        assert.equal(archives.length, 1)
        const archive = await native.mem_get_observation.execute({ id: archives[0].id }, { agent: host })
        assert.equal(archive.topic_key, 'session/compaction-recovery')
        assert.equal(archive.session_id, host.id)
        const provider = h.contexts[0].text
        assert.equal(provider({ agent: agent('other-agent', projectDir) }), '')
        const notice = provider({ agent: host })
        assert.match(notice, /already saved/); assert.ok(!notice.includes('{{'))
        await h.events['agent/turn-stopping']({ agent: host })
        assert.equal(provider({ agent: host }), '')
        await native.mem_save.execute({ title: 'After turn stopping', content: 'dshp2laterunique later save must not reuse an expired prompt' }, { agent: host })
        assert.equal(observations.at(-1).current_prompt, undefined)
        console.log('real-server P2: inbox prompt persisted; current_prompt dedupe = 1 prompt; passive learning extracted; compaction topic_key confirmed; recovery Confirmed and cleared after delivery')
      } finally {
        for (const dispose of h.disposers) dispose()
        globalThis.fetch = originalFetch
      }
    })

    await t.test('P4.1: lost real Go acknowledgement resolves exactly one committed observation through TCP proxy', async t => {
      const proxy = await lossySaveProxy(url)
      t.after(proxy.close)
      const runtime = new Runtime(config(proxy.url))
      const tools = Object.fromEntries(createTools(runtime).map(tool => [tool.name, tool]))
      const exec = { agent: agent('dsh-recovered-save', projectDir) }
      const result = await tools.mem_save.execute({ title: 'Recovered receipt', content: 'dshlostackunique authoritative ledger recovers a dropped save response' }, exec)
      assert.ok(result.id > 0); assert.equal(result.status, 'committed')
      const found = await tools.mem_search.execute({ query: 'dshlostackunique' }, exec)
      assert.equal(found.length, 1); assert.equal(found[0].id, result.id)
      assert.equal(proxy.posts, 1); assert.equal(proxy.dropped, true)
      console.log('real-server P4.1: dropped TCP response recovered as committed; one POST and one stored observation')
    })

    await t.test('P4.2: explicit satellite and implicit root writes remain isolated and end together', async () => {
      const otherDir = join(home, 'other-project')
      await mkdir(join(otherDir, '.engram'), { recursive: true })
      await writeFile(join(otherDir, '.engram/config.json'), JSON.stringify({ project_name: 'other' }))
      const host = agent('dsh-satellite-agent', projectDir), exec = { agent: host }
      const foreign = await tools.mem_save.execute({ title: 'Satellite observation', content: 'dshsatelliteunique explicit destination', project: 'other' }, exec)
      const satellite = await tools.mem_get_observation.execute({ id: foreign.id }, exec)
      assert.equal(satellite.project, 'other'); assert.equal(satellite.session_id, host.id + '@other')
      const implicit = await tools.mem_save.execute({ title: 'Root observation', content: 'dshrootunique implicit current project' }, exec)
      assert.equal((await tools.mem_get_observation.execute({ id: implicit.id }, exec)).session_id, host.id)
      await tools.mem_save_prompt.execute({ content: 'dshsatpromptunique prompt in the explicit project', project: 'other' }, exec)
      assert.equal((await tools.mem_search_prompts.execute({ query: 'dshsatpromptunique', project: 'other' }, exec))[0].session_id, host.id + '@other')
      const summary = await tools.mem_session_summary.execute({ content: 'dshsatsummaryunique cwd-selected summary', cwd: otherDir, project: 'other' }, exec)
      assert.equal((await tools.mem_get_observation.execute({ id: summary.id }, exec)).session_id, host.id + '@other')
      const finalized = await tools.mem_session_finalize.execute({ summary: 'dshsatfinalunique isolated finalization', project: 'finished-other' }, exec)
      assert.equal(finalized.session_id, host.id + '@finished-other')
      assert.equal(finalized.state, 'finalized')
      await tools.mem_session_end.execute({}, exec)
      const rootRow = await runtime.client.request('/sessions/' + encodeURIComponent(host.id))
      const satelliteRow = await runtime.client.request('/sessions/' + encodeURIComponent(host.id + '@other'))
      assert.ok(rootRow.ended_at); assert.ok(satelliteRow.ended_at); assert.equal(satelliteRow.directory, '')
      const continued = await tools.mem_save.execute({ title: 'Satellite continuation', content: 'dshsatcontinuedunique resumed isolated destination', project: 'other' }, exec)
      const resumed = await tools.mem_get_observation.execute({ id: continued.id }, exec)
      assert.ok(resumed.session_id.startsWith(host.id + '@other:resume:'))
      console.log('real-server P4.2: explicit project uses agent@other; implicit writes keep root; prompt/summary/finalize target correctly; root and satellite ended; isolated continuation confirmed')
    })

  } finally {
    await stop()
  }
})
