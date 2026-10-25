import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { EngramHttpError } from './client.ts'
import { ConfigurationError } from './diagnostics.ts'
import type { Client } from './client.ts'

// Match Go's NFC, simple Unicode lowercase and unicode.IsSpace semantics.
export function labelKey(name: string): string {
  const lower = Array.from(name.normalize('NFC'), char => char === '\u0130' ? 'i' : char.toLowerCase()).join('')
  return lower.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '').normalize('NFC').replace(/[-_.\p{White_Space}]+/gu, '-')
}

export interface Agent { id: string; session: { header: { cwd?: string; origin?: string; delegationDepth?: number } } }
export interface Provenance { source: string; directory: string; raw_project?: string }
export interface Project { cwd: string; project: string; provenance: Provenance; response: Record<string, unknown> }
export function agentCwd(agent: Agent): string {
  const cwd = agent?.session?.header?.cwd
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) throw new Error('Agent session.header.cwd must be an absolute directory')
  return cwd
}
async function localConfig(cwd: string): Promise<Record<string, unknown>> {
  let current = cwd
  for (;;) {
    let text: string
    try { text = await readFile(join(current, '.engram/config.json'), 'utf8') }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new ConfigurationError('project', 'Could not read .engram/config.json', cwd + ':Could not read .engram/config.json')
      const parent = dirname(current)
      if (parent === current) throw new ConfigurationError('project', 'Server lacks /project/current and no .engram/config.json was found', cwd + ':Server lacks /project/current and no .engram/config.json was found')
      current = parent; continue
    }
    try {
      const data = JSON.parse(text)
      return { project: data.project_name, raw_project: data.project_name, project_source: 'config', cwd, project_path: current }
    } catch { throw new ConfigurationError('project', 'Invalid .engram/config.json', cwd + ':Invalid .engram/config.json') }
  }
}
export class Projects {
  readonly client: Client
  readonly now: () => number
  private cache = new Map<string, { value?: Project; error?: Error; at: number }>()
  private flights = new Map<string, Promise<Project>>()
  constructor(client: Client, now = Date.now) { this.client = client; this.now = now }
  async resolve(cwd: string, signal?: AbortSignal): Promise<Project> {
    if (!isAbsolute(cwd)) throw new Error('Project cwd must be absolute')
    signal?.throwIfAborted()
    const cached = this.cache.get(cwd)
    if (cached?.value) return cached.value
    if (cached?.error && this.now() - cached.at < 30000) throw cached.error
    // Caller cancellation is never shared between otherwise independent tool invocations.
    if (!signal && this.flights.has(cwd)) return this.flights.get(cwd)!
    const flight = this.detect(cwd, signal).then(value => {
      this.cache.set(cwd, { value, at: this.now() }); return value
    }, error => {
      if (!signal?.aborted) this.cache.set(cwd, { error, at: this.now() })
      throw error
    })
    if (!signal) this.flights.set(cwd, flight)
    try { return await flight } finally { if (this.flights.get(cwd) === flight) this.flights.delete(cwd) }
  }
  private async detect(cwd: string, signal?: AbortSignal): Promise<Project> {
    let last: unknown
    for (let attempt = 0; attempt < 5; attempt++) {
      let data: Record<string, unknown>
      try { data = await this.client.request(`/project/current?cwd=${encodeURIComponent(cwd)}&aliases=true`, { signal }) }
      catch (error) {
        signal?.throwIfAborted()
        if (error instanceof EngramHttpError && error.status === 404) data = await localConfig(cwd)
        else if (error instanceof EngramHttpError && error.status === 409 && error.code === 'explicit_project_required') throw new ConfigurationError('project', 'Explicit project required; start DSH in a project directory', cwd + ':Explicit project required; start DSH in a project directory')
        else {
          // Contract failures must fail closed immediately, never use a config fallback.
          if (error instanceof Error && error.name === 'RuntimeContractError') throw error
          last = error
          if (attempt < 4) await delay(200, undefined, { signal })
          continue
        }
      }
      const candidate = typeof data?.project === 'string' ? data.project.trim() : ''
      if (!candidate || candidate.toLowerCase() === 'unknown' || data.error_hint !== undefined || /[\\/\x00-\x1f\x7f]/.test(candidate)) throw new ConfigurationError('project', 'Engram project resolution failed; check project configuration', cwd + ':Engram project resolution failed; check project configuration')
      // Evidence only, ported from Pi captureProjectProvenance.
      return { cwd, project: candidate, response: data, provenance: {
        source: typeof data.project_source === 'string' ? data.project_source || 'unknown' : 'unknown', directory: cwd,
        ...(typeof data.raw_project === 'string' ? { raw_project: data.raw_project } : {}),
      } }
    }
    throw last instanceof Error ? last : new Error('Engram project resolution failed after five attempts')
  }
}
