import type { Client } from './client.ts'
import type { Agent, Project } from './project.ts'
import type { Projects } from './project.ts'
import type { Sessions, SessionState } from './session.ts'

export interface WriteTarget { id: string; agentId: string; project: Project; satellite: boolean }
const routedTools = new Set(['mem_save', 'mem_save_prompt', 'mem_session_summary', 'mem_session_finalize'])
function canonical(value: string): string { return value.normalize('NFC').toLowerCase().trim().normalize('NFC').replace(/--+/g, '-').replace(/__+/g, '_') }
export class SatelliteEndError extends Error {
  readonly rootEnded = true
  constructor(failures: string[]) { super(`Root session ended successfully; satellite cleanup failed: ${failures.join('; ')}. Retry mem_session_end explicitly to finish cleanup.`); this.name = 'SatelliteEndError' }
}
export class Satellites {
  private client: Client
  private sessions: Sessions
  private projects: Projects
  private known = new Map<string, Map<string, { target: WriteTarget; state: SessionState }>>()
  private endedRoots = new Map<string, { id: string; result: unknown }>()
  constructor(client: Client, sessions: Sessions, projects: Projects) { this.client = client; this.sessions = sessions; this.projects = projects }
  async resolve(name: string, agent: Agent, root: Project, args: Record<string, unknown>, signal?: AbortSignal): Promise<WriteTarget> {
    const implicit = { id: agent.id, agentId: agent.id, project: root, satellite: false }
    if (!routedTools.has(name) || (args.project === undefined && args.cwd === undefined)) return implicit
    const requested = typeof args.project === 'string' ? canonical(args.project) : undefined
    if (requested && (requested === 'unknown' || /[\\/\x00-\x1f\x7f]/.test(requested))) throw new Error('Invalid explicit project')
    const detected = typeof args.cwd === 'string' ? await this.projects.resolve(args.cwd, signal) : undefined
    if (requested && detected && requested !== canonical(detected.project)) throw new Error('Explicit project does not match the project resolved from cwd')
    const selected = requested ?? (detected ? canonical(detected.project) : root.project)
    const project = { ...root, provenance: detected?.provenance ?? { source: 'explicit_override', directory: root.cwd, raw_project: args.project as string }, project: selected }
    if (selected === canonical(root.project)) return { ...implicit, project: { ...project, project: root.project } }
    return { id: `${agent.id}@${selected}`, agentId: agent.id, project, satellite: true }
  }
  async register(target: WriteTarget, signal?: AbortSignal): Promise<SessionState> {
    const state = await this.sessions.register(target.id, target.project, signal, false, target.satellite)
    if (target.satellite) {
      const entries = this.known.get(target.agentId) ?? new Map()
      entries.set(target.id, { target, state }); this.known.set(target.agentId, entries)
    }
    return state
  }
  async write(target: WriteTarget, path: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const state = await this.register(target, signal)
    return this.client.request(path, { method: 'POST', signal, body: { ...body, session_id: state.effectiveId, project: state.project, project_provenance: target.project.provenance } })
  }
  async finalize(target: WriteTarget, summary: string, signal?: AbortSignal): Promise<unknown> {
    try {
      const result = await this.sessions.finalize(target.id, target.project, summary, signal, target.satellite)
      if (target.satellite) this.known.get(target.agentId)?.delete(target.id)
      return result
    } catch (error) {
      const state = this.sessions.states.get(target.id)
      if (target.satellite && state) {
        const entries = this.known.get(target.agentId) ?? new Map()
        entries.set(target.id, { target, state }); this.known.set(target.agentId, entries)
      }
      throw error
    }
  }
  async endRoot(agent: Agent, project: Project, summary?: string, signal?: AbortSignal): Promise<unknown> {
    let ended = this.endedRoots.get(agent.id)
    const current = this.sessions.states.get(agent.id)
    if (!ended || (current && current.effectiveId !== ended.id)) {
      const result = await this.sessions.end(agent.id, project, summary, signal) as { id: string }
      ended = { id: result.id, result }; this.endedRoots.set(agent.id, ended)
    }
    const failures: string[] = []
    const entries = this.known.get(agent.id)
    for (const [id, entry] of entries ?? []) {
      try { await this.sessions.end(id, entry.target.project, '', signal, entry.state); entries!.delete(id) }
      catch (error) { failures.push(`${entry.target.project.project}: ${error instanceof Error ? error.message : String(error)}`) }
      finally { this.sessions.invalidate(id) }
    }
    this.sessions.invalidate(agent.id)
    if (failures.length) throw new SatelliteEndError(failures)
    this.endedRoots.delete(agent.id); this.known.delete(agent.id)
    return ended.result
  }
  dispose(id: string): void {
    for (const satellite of this.known.get(id)?.keys() ?? []) this.sessions.dispose(satellite)
    this.known.delete(id); this.endedRoots.delete(id)
  }
  close(): void { for (const id of this.known.keys()) this.dispose(id); this.endedRoots.clear() }
}
