import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { hasErrorCode, EngramUnavailableError } from './client.ts'
import { ConfigurationError } from './diagnostics.ts'
import type { Config } from './config.ts'

const run = promisify(execFile)
export class OwnershipError extends ConfigurationError {
  constructor(message: string, key = message) { super('ownership', message, key); this.name = 'OwnershipError' }
}
export function startupBackoffMs(failures: number): number { return Math.min(60000, 1000 * 2 ** (failures - 1)) }
// SemVer boundary ported from plugin/pi/index.ts:isPreIdentityEngramVersion.
function legacyVersion(version: unknown): boolean {
  if (typeof version !== 'string') return false
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(version)
  if (!match) return false
  const [major, minor, patch] = match.slice(1, 4).map(Number)
  if (major! < 2) return true
  if (major !== 2 || minor !== 0 || patch !== 0) return false
  const pre = match[4]?.split('.')
  if (!pre || pre.some(s => /^\d+$/.test(s) && s.length > 1 && s.startsWith('0'))) return false
  const boundary = ['rc', '11']
  for (let i = 0; i < Math.max(pre.length, boundary.length); i++) {
    const a = pre[i], b = boundary[i]
    if (a === undefined) return true
    if (b === undefined) return false
    if (a === b) continue
    const an = /^\d+$/.test(a), bn = /^\d+$/.test(b)
    return an && bn ? Number(a) < Number(b) : an !== bn ? an : a < b
  }
  return false
}
export function ownership(health: { instance_id?: unknown; version?: unknown }, expected: string): 'ready' | 'foreign' | 'legacy' | 'identity_missing' {
  if (typeof health.instance_id !== 'string' || !health.instance_id) return legacyVersion(health.version) ? 'legacy' : 'identity_missing'
  return health.instance_id === expected ? 'ready' : 'foreign'
}
export class Server {
  readonly config: Config
  localId?: string
  private flight?: Promise<void>
  private ready = false
  private failure?: Error
  private retryAt = 0
  private failures = 0
  readonly now: () => number
  constructor(config: Config, now = Date.now) { this.config = config; this.now = now }
  reset(): void {
    // Never discard an active initialization or its failure/backoff state.
    if (!this.config.url && this.ready) { this.flight = undefined; this.ready = false }
  }
  ensure(): Promise<void> {
    if (this.flight) return this.flight
    if (this.failure && this.now() < this.retryAt) return Promise.reject(this.failure)
    this.flight = this.initialize().then(() => {
      this.ready = true; this.failure = undefined; this.failures = 0
    }, error => {
      this.flight = undefined
      this.failure = error instanceof Error ? error : new Error('Engram startup failed')
      this.retryAt = this.now() + (error instanceof OwnershipError ? 5000 : startupBackoffMs(++this.failures))
      throw this.failure
    })
    return this.flight
  }
  private async probe(): Promise<void> {
    const res = await fetch(`http://127.0.0.1:${this.config.port}/health`, { signal: AbortSignal.timeout(500) })
    if (!res.ok) throw new Error('Engram health unavailable')
    const health = await res.json() as Record<string, unknown>
    const state = ownership(health, this.localId!)
    if (state !== 'ready') throw new OwnershipError(`Engram ownership check failed: ${state}. No process was adopted or terminated.`, `${state}:${String(health.instance_id ?? '')}`)
  }
  private async initialize(): Promise<void> {
    if (this.config.url) return
    let id: string
    try { id = (await run(this.config.engramBin, ['instance-id'], { timeout: 2000, maxBuffer: 4096 })).stdout.trim() }
    catch { throw new OwnershipError('Engram instance-id failed; verify ENGRAM_BIN and upgrade Engram') }
    if (!/^[a-f0-9]{32}$/.test(id)) throw new OwnershipError('Engram instance-id must be 32 hexadecimal characters')
    this.localId = id
    try { await this.probe(); return }
    catch (error) {
      if (!hasErrorCode(error, 'ECONNREFUSED')) throw error
    }
    // Shared serve deliberately survives DSH. Never kill this process.
    const child = spawn(this.config.engramBin, ['serve'], { detached: true, stdio: 'ignore', env: { ...process.env, ENGRAM_PORT: String(this.config.port) } })
    await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', () => reject(new Error('Could not spawn Engram serve'))) })
    child.unref()
    const deadline = this.now() + 10000
    while (this.now() < deadline) {
      try { await this.probe(); return }
      catch (error) { if (!hasErrorCode(error, 'ECONNREFUSED')) throw error }
      await delay(100)
    }
    throw new EngramUnavailableError()
  }
}
