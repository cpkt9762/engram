import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { home, projection, startRealServer, stub, json, contract } from './helpers.test.mjs'

const runtimeRoot = process.env.DSH_RUNTIME_ROOT ?? '/Users/pingzi/.local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'
const packages = ['cordis', 'dsh-tools', 'dsh-system-prompt', 'dsh-scope']
const missing = packages.map(name => join(runtimeRoot, name, 'lib/index.js')).find(path => !existsSync(path))
const title = 'real DSH host mounting, assembly, dispatch and disposal' + (missing ? ` [SKIPPED: missing ${missing}]` : '')
const load = name => import(pathToFileURL(join(runtimeRoot, name, 'lib/index.js')).href)

// All host modules MUST come from this one installation. Mixing the dev peer
// copy with installed cordis/scope/tools splits registry and scope ownership.
async function rig(t) {
  const [{ Context }, { ToolRuntime }, prompts, scopeApi] = await Promise.all(packages.map(load))
  const root = new Context(), logs = [], fibers = [], scopes = []
  root.logger.exporter({ levels: { default: 3 }, export: message => logs.push(message) })
  const system = root.registry.plugin(prompts.SystemPrompt, { includeHarnessIdentity: false })
  fibers.push(system); await system.await()
  const tools = root.registry.plugin(ToolRuntime, { mode: 'native' })
  fibers.push(tools); await tools.await()
  let control
  const minter = root.registry.plugin({ name: 'engram-host-test-minter', inject: ['tools', 'systemPrompt'], apply: ctx => { control = ctx } })
  fibers.push(minter); await minter.await()
  assert.ok(control)
  const makeAgent = id => {
    const agent = { id, session: { id, header: { cwd: home } }, options: {} }
    const scope = scopeApi.createScope(control, agent)
    scopes.push(scope); agent.ctx = scope.ctx
    return agent
  }
  t.after(async () => {
    for (const scope of scopes.reverse()) await scope.dispose()
    for (const fiber of fibers.reverse()) await fiber.dispose()
    await root.fiber.dispose()
  })
  const mount = async url => {
    // cordis-plugin-loader unwrapExports: exports.default ?? exports, then
    // registry.plugin(plugin, config). Mount the module object, not an apply shim.
    const module = await import('../index.ts')
    const plugin = module.default ?? module
    assert.equal(plugin, module)
    const fiber = root.registry.plugin(plugin, { url })
    fibers.push(fiber)
    return { fiber }
  }
  return { root, control, makeAgent, mount, logs, fibers, ...prompts, ...scopeApi }
}
function untilLog(r, pattern) {
  const match = message => pattern.test(message.args.map(arg => arg instanceof Error ? arg.message : String(arg)).join(' '))
  const present = r.logs.find(match)
  if (present) return Promise.resolve(present)
  let unwatch, timer
  return new Promise((resolve, reject) => {
    unwatch = r.root.logger.exporter({ levels: { default: 3 }, export: message => { if (match(message)) resolve(message) } })
    timer = setTimeout(() => reject(new Error('expected real host diagnostic was not emitted')), 5000)
  }).finally(() => { clearTimeout(timer); unwatch() })
}

test(title, { skip: missing ? `missing runtime package ${missing}` : false, timeout: 850000 }, async t => {
  const backend = await startRealServer()
  t.after(backend.stop)
  const projectDir = join(home, 'host-project')
  await mkdir(join(projectDir, '.engram'), { recursive: true })
  await writeFile(join(projectDir, '.engram/config.json'), JSON.stringify({ project_name: 'dsh-host-real' }))

  await t.test('real registry accepts all schemas, native executions validate outputs, scoped assembly and unload are correct', async t => {
    const r = await rig(t), { fiber } = await r.mount(backend.url)
    await fiber.await()
    const host = r.makeAgent('real-host-agent'), other = r.makeAgent('real-other-agent')
    host.session.header.cwd = projectDir; other.session.header.cwd = projectDir
    const names = () => r.control.tools.schemas(host).map(tool => tool.name).sort()
    assert.deepEqual(names(), Object.keys(projection.operations).sort())
    let executions = 0, observedExecution
    r.root.on('tools/execute', (exec, next) => {
      assert.equal(typeof exec.token, 'symbol')
      assert.equal(typeof exec.deferContext, 'function')
      assert.equal(Object.isFrozen(exec.arguments), true)
      observedExecution = exec
      executions++
      return next()
    })
    const call = async (name, args = {}) => {
      // ToolExecutionInput only: ToolRuntime mints the actual exec/token/context.
      const result = await r.control.tools.execute({ callId: randomUUID(), name, arguments: args, agent: host, signal: new AbortController().signal })
      assert.equal(result.isError, false, JSON.stringify(result.error))
      assert.doesNotMatch(JSON.stringify(result), /ToolOutputError/)
      return result.value
    }
    await r.root.serial(r.scopeTarget(host, host), 'agent/created', { agent: host, source: 'startup' })
    assert.equal((await call('mem_current_project')).project, 'dsh-host-real')
    const saved = await call('mem_save', { title: 'Real host record', content: 'dshhostunique native execution through the real DSH output validator' })
    assert.ok(saved.id > 0)
    assert.ok(Array.isArray(await call('mem_search', { query: 'dshhostunique' })))
    const compact = await call('mem_search', { query: 'dshhostunique', response_format: 'compact' })
    assert.ok(Array.isArray(compact.results))
    assert.equal((await call('mem_get_observation', { id: saved.id })).id, saved.id)
    assert.ok((await call('mem_list_projects')).projects.some(project => JSON.stringify(project).includes('dsh-host-real')))
    assert.equal(executions, 6)

    const initial = await r.control.systemPrompt.assemble({ scope: host })
    assert.ok(initial.sections.some(section => section.name === 'engram-dsh:memory-protocol'))
    assert.match(r.renderPrompt(initial), /The agent MUST follow this protocol without waiting for activation/)
    assert.equal(r.renderContextSnapshot(initial), '')
    // A real DSH assembleContextFor(agent) supplies both agent and scope. Scope
    // alone selects layers; it does not synthesize context.agent for providers.
    const compactEvent = { type: 'compaction/summary', data: { compactionId: 'host-compaction', summary: [{ type: 'text', text: 'real host recovery summary with {{untrusted}} input' }] } }
    r.root.emit(r.scopeTarget(host, host), 'session/event', host.session, compactEvent)
    await r.root.serial(r.scopeTarget(host, host), 'agent/turn-stopping', { agent: host, turn: 1, signal: new AbortController().signal })
    const recovered = await r.control.systemPrompt.assemble({ scope: host, agent: host })
    assert.match(r.renderContextSnapshot(recovered), /already saved/)
    assert.ok(r.renderContextSections(recovered).some(section => section.name === 'engram-dsh:compaction-recovery'))
    const unrelated = await r.control.systemPrompt.assemble({ scope: other, agent: other })
    assert.equal(r.renderContextSnapshot(unrelated), '')
    await r.root.serial(r.scopeTarget(host, host), 'agent/turn-stopping', { agent: host, turn: 1, signal: new AbortController().signal })
    assert.equal(r.renderContextSnapshot(await r.control.systemPrompt.assemble({ scope: host, agent: host })), '')

    // Keep a live pending notice at unload, so context withdrawal is observable.
    r.root.emit(r.scopeTarget(host, host), 'session/event', host.session, { ...compactEvent, data: { ...compactEvent.data, compactionId: 'host-compaction-2' } })
    await r.root.serial(r.scopeTarget(host, host), 'agent/turn-stopping', { agent: host, turn: 2, signal: new AbortController().signal })
    const beforeUnload = await r.control.systemPrompt.assemble({ scope: host, agent: host })
    assert.match(r.renderContextSnapshot(beforeUnload), /already saved/)
    const retainedDefinition = r.control.tools.get('mem_save', host)
    await fiber.dispose()
    assert.deepEqual(names(), [])
    const unloaded = await r.control.systemPrompt.assemble({ scope: host, agent: host })
    assert.ok(!unloaded.sections.some(section => section.name === 'engram-dsh:memory-protocol'))
    assert.ok(!unloaded.contexts.some(context => context.name === 'engram-dsh:compaction-recovery'))
    assert.equal(r.renderContextSnapshot(unloaded), '')
    // Reuse an execution minted by the host; never fabricate ToolRunContext.
    await assert.rejects(retainedDefinition.execute({ title: 'late', content: 'unloaded runtime must reject late work' }, observedExecution), /unloaded/)
    console.log('real DSH host: 23 schemas accepted; 6 native executions passed output validation; strict context rendered; scoped recovery and full unload passed')
  })

  await t.test('duplicate native tool makes module mounting fail through fiber.await rejection', async t => {
    const r = await rig(t)
    const duplicate = r.root.registry.plugin({ name: 'existing-memory-plugin', inject: ['tools'], apply: ctx => {
      ctx.tools.register({ name: 'mem_search', description: 'existing tool', parameters: { type: 'object', properties: {} }, output: { schema: { type: 'object', additionalProperties: true }, render: () => [] }, execute: async () => ({}) })
    } })
    r.fibers.push(duplicate); await duplicate.await()
    const { fiber } = await r.mount(backend.url)
    await assert.rejects(fiber.await(), /mem_search.*already registered/)
    assert.deepEqual(r.control.tools.schemas().map(tool => tool.name), ['mem_search'], 'failed mount must roll back earlier registrations')
    assert.ok(r.logs.some(message => message.type === 'error' && message.args.some(arg => arg instanceof Error && /already registered/.test(arg.message))))
    console.log('real DSH duplicate: fiber.await() rejected with mem_search already registered; partial mount rolled back')
  })

  await t.test('unavailable Engram never rejects created or turn-stopping serial events', async t => {
    const unavailable = await stub(t, () => {})
    await new Promise(resolve => unavailable.server.close(resolve))
    const r = await rig(t), { fiber } = await r.mount(unavailable.url)
    await fiber.await()
    const host = r.makeAgent('unavailable-host')
    host.session.header.cwd = projectDir
    let createdTail = false, stoppingTail = false
    r.root.on('agent/created', () => { createdTail = true; return undefined })
    r.root.on('agent/turn-stopping', () => { stoppingTail = true; return undefined })
    const warning = untilLog(r, /Engram warmup failed/)
    assert.equal(await r.root.serial(r.scopeTarget(host, host), 'agent/created', { agent: host, source: 'startup' }), undefined)
    assert.equal(createdTail, true)
    await warning
    assert.equal(await r.root.serial(r.scopeTarget(host, host), 'agent/turn-stopping', { agent: host, turn: 1, signal: new AbortController().signal }), undefined)
    assert.equal(stoppingTail, true)
    await fiber.dispose()
    console.log('real DSH lifecycle: unavailable warmup logged; both serial event chains continued')
  })
  await t.test('persistent failures reach the real logger default level once', async t => {
    const { url } = await stub(t, (req, res) => json(res, { ...contract(), revision: 999 }))
    const r = await rig(t), defaults = []
    // No levels override: the real Cordis default exporter threshold is level1.
    r.root.logger.exporter({ export: message => defaults.push(message) })
    const { fiber } = await r.mount(url)
    await fiber.await()
    const host = r.makeAgent('persistent-config-host')
    for (let i = 0; i < 3; i++) {
      const result = await r.control.tools.execute({ callId: randomUUID(), name: 'mem_current_project', arguments: {}, agent: host, signal: new AbortController().signal })
      assert.equal(result.isError, true)
      assert.match(result.error.message, /projection mismatch/)
    }
    assert.equal(defaults.length, 1)
    assert.equal(defaults[0].type, 'error'); assert.equal(defaults[0].level, 0)
    console.log('real DSH persistent configuration error: visible at default logger level, three failures emitted one error')
  })

})
