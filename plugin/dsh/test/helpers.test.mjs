import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { after } from 'node:test'

// Every test worker and child has private HOME/state, no inherited cloud settings.
export const cleanEnv = (home, extra = {}) => ({ ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('ENGRAM_'))), HOME: home, ...extra })
export const home = await mkdtemp(join(tmpdir(), 'engram-dsh-test-'))
for (const key of Object.keys(process.env)) if (key.startsWith('ENGRAM_')) delete process.env[key]
process.env.HOME = home
process.env.ENGRAM_DATA_DIR = join(home, 'data')
process.env.ENGRAM_CLOUD_AUTOSYNC = '0'
after(() => rm(home, { recursive: true, force: true }))
export const projection = JSON.parse(readFileSync(new URL('../runtime-contract.json', import.meta.url), 'utf8'))
export const identity = 'a'.repeat(32)
export const contract = () => ({ ...projection, instance_id: identity })
export const config = url => ({ url, port: 1, engramBin: '/nonexistent-engram-dsh', token: '' })
export const agent = (id = 'test-agent', cwd = home) => ({ id, session: { header: { cwd } } })
export function json(res, data, status = 200) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)) }
export async function body(req) { let text = ''; for await (const chunk of req) text += chunk; return JSON.parse(text) }
export async function stub(t, handler) {
  const server = createServer((req, res) => { Promise.resolve(handler(req, res)).catch(error => { res.destroy(error) }) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  return { url: `http://127.0.0.1:${server.address().port}`, server }
}
// Valid independent calls for routing/guard tests; conflict authority stays Go-owned.
export const toolArgs = {
  mem_current_project: {}, mem_save: { title: 'title', content: 'content' }, mem_search: { query: 'q' }, mem_context: {},
  mem_search_prompts: { query: 'q' }, mem_get_observation: { id: 7, include_history: true, history_cursor: 0 },
  mem_session_summary: { content: 'summary' }, mem_update: { id: 7, expected_project: 'current', find: 'old', replace: 'new' },
  mem_suggest_topic_key: { type: 'pattern', title: 'title', content: 'content' },
  mem_consolidate: { ids_to_delete: [7, 8], new_title: 'merged', new_content: 'content', expected_project: 'current' },
  mem_judge_many: { judgments: [{ judgment_id: 'rel-a', relation: 'compatible', confidence: 0.8 }], session_id: 'caller' },
  mem_session_finalize: { summary: '## Goal\nComplete work.' }, mem_save_prompt: { content: 'prompt' },
  mem_session_start: {}, mem_session_end: { summary: 'summary' }, mem_doctor: { check: 'caller-binding' },
  mem_capture_passive: { content: '## Key Learnings:\n- A detailed reusable learning about isolated memory tools and local test fixtures.' },
  mem_review: { action: 'list' }, mem_judge: { judgment_id: 'rel-a', relation: 'compatible', confidence: 0.8 },
  mem_compare: { memory_id_a: 7, memory_id_b: 8, relation: 'related', confidence: 0.7, reasoning: 'Different aspects of one topic' },
  mem_list_projects: {}, mem_pin: { id: 7 }, mem_unpin: { id: 7 },
}
export function fakeContext() {
  const events = {}, tools = [], sections = [], contexts = [], logs = [], disposers = []
  const ctx = {
    tools: { register: tool => tools.push(tool) },
    systemPrompt: { section: section => sections.push(section), context: context => contexts.push(context) },
    on: (name, listener) => { events[name] = listener },
    logger: () => ({ warn: (...args) => logs.push(args), error: (...args) => logs.push(args) }),
    effect: factory => { disposers.push(factory()) },
  }
  return { ctx, events, tools, sections, contexts, logs, disposers }
}

let realServerBuilt = false
// Shared Go fixture authority: both HTTP and real-host tests build the existing
// Pi bridge, with a private HOME, writable module cache, and no inherited cloud.
export async function startRealServer() {
  const directory = await mkdtemp(join(home, 'server-'))
  const fixtureHome = join(directory, 'home')
  await mkdir(fixtureHome)
  const env = cleanEnv(fixtureHome, { GOFLAGS: '-modcacherw', ENGRAM_DATA_DIR: join(directory, 'data'), ENGRAM_CLOUD_AUTOSYNC: '0' })
  const root = fileURLToPath(new URL('../../..', import.meta.url))
  const executable = join(home, 'real-server')
  if (!realServerBuilt) {
    console.log('real-server cold build uptime: ' + execFileSync('uptime', { env, encoding: 'utf8' }).trim())
    const build = spawnSync('timeout', ['540s', 'go', 'build', '-o', executable, './plugin/pi/test/support/real-server'], { cwd: root, env, encoding: 'utf8', timeout: 550000 })
    assert.ifError(build.error); assert.equal(build.status, 0, build.stderr)
    realServerBuilt = true
  }
  const child = spawn(executable, [join(directory, 'store')], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += chunk })
  const lines = createInterface({ input: child.stdout })
  const stop = async () => {
    lines.close()
    if (child.exitCode === null) { const stopped = once(child, 'exit'); child.stdin.end(); await stopped }
  }
  try {
    const url = await new Promise((resolve, reject) => {
      const finish = (error, line) => { clearTimeout(timer); child.off('error', onError); child.off('exit', onExit); lines.off('line', onLine); error ? reject(error) : resolve(line) }
      const onError = error => finish(error), onExit = code => finish(new Error('real-server exited ' + code + ': ' + stderr)), onLine = line => finish(null, line)
      const timer = setTimeout(() => finish(new Error('real-server startup timeout')), 15000)
      child.once('error', onError); child.once('exit', onExit); lines.once('line', onLine)
    })
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/)
    assert.notEqual(new URL(url).port, '7437')
    return { url, stop }
  } catch (error) { await stop(); throw error }
}
// A real TCP forwarder with Connection: close to make each request observable.
// Forward the first observation POST, then discard its response after Go commits.
export async function lossySaveProxy(backend) {
  const { createServer, connect } = await import('node:net')
  const target = new URL(backend), sockets = new Set()
  let dropped = false, posts = 0
  const proxy = createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {})
    let initial = Buffer.alloc(0)
    const header = chunk => {
      initial = Buffer.concat([initial, chunk])
      const boundary = initial.indexOf('\r\n\r\n')
      if (boundary < 0) return
      socket.off('data', header)
      const head = initial.subarray(0, boundary).toString('latin1')
      const observation = /^POST \/observations HTTP\//.test(head)
      if (observation) posts++
      const discard = observation && !dropped
      if (discard) dropped = true
      const upstream = connect(Number(target.port), '127.0.0.1')
      sockets.add(upstream); upstream.on('close', () => sockets.delete(upstream))
      upstream.on('error', () => socket.destroy())
      socket.on('close', () => upstream.destroy())
      if (discard) upstream.once('data', () => { socket.destroy(); upstream.destroy() })
      else upstream.pipe(socket)
      upstream.write(head.replace(/\r\nconnection:[^\r\n]*/ig, '') + '\r\nConnection: close\r\n\r\n', 'latin1')
      upstream.write(initial.subarray(boundary + 4)); socket.pipe(upstream)
    }
    socket.on('data', header)
  })
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${proxy.address().port}`, get posts() { return posts }, get dropped() { return dropped }, close: async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => proxy.close(resolve)) } }
}
