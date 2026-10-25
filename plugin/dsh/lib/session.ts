import { EngramHttpError } from './client.ts'
import { ConfigurationError } from './diagnostics.ts'
import type { Client } from './client.ts'
import type { Project } from './project.ts'

export interface SessionState extends Project { effectiveId: string; registeredAt: number; isolated?: boolean }
export class SessionProjectConflictError extends Error {
  constructor() { super('DSH session belongs to another Engram project. Start a new DSH agent in this project.'); this.name = 'SessionProjectConflictError' }
}
interface Closing {
  state: SessionState
  flight?: Promise<unknown>
  uncertain: boolean
}
export class Sessions {
  readonly client: Client
  readonly now: () => number
  readonly states = new Map<string, SessionState>()
  private finalizations = new Map<string, Closing>()
  private endings = new Map<string, Closing>()
  private generations = new Map<string, object>()
  private flights = new Map<string, Promise<SessionState>>()
  private reportConfiguration: (error: ConfigurationError) => void
  constructor(client: Client, now = Date.now, reportConfiguration: (error: ConfigurationError) => void = () => {}) {
    this.client = client; this.now = now; this.reportConfiguration = reportConfiguration
  }
  invalidate(id: string): void {
    this.states.delete(id); this.generations.delete(id); this.flights.delete(id)
  }
  dispose(id: string): void { this.invalidate(id); this.finalizations.delete(id); this.endings.delete(id) }
  async register(id: string, project: Project, signal?: AbortSignal, force = false, isolated = false): Promise<SessionState> {
    signal?.throwIfAborted()
    if (this.finalizations.has(id) || this.endings.has(id)) throw new Error('DSH session is closing or finalized; retry only the explicit session close tool with the same host identity')
    if (!id) throw new Error('DSH agent.id is required')
    const state = this.states.get(id)
    if (state && !!state.isolated !== isolated) throw new Error('Session isolation mode does not match the requested registration')
    if (state && (state.project !== project.project || state.cwd !== project.cwd)) throw new SessionProjectConflictError()
    if (state && !force && this.now() - state.registeredAt <= 60000) return state
    const pending = this.flights.get(id)
    if (pending) {
      const result = await pending
      signal?.throwIfAborted()
      if (!!result.isolated !== isolated) throw new Error('Session isolation mode does not match the requested registration')
      if (result.project !== project.project || result.cwd !== project.cwd) throw new SessionProjectConflictError()
      return result
    }
    const generation = {}
    this.generations.set(id, generation)
    const flight = this.create(id, project, generation, signal, isolated).catch(error => {
      if (error instanceof ConfigurationError) this.reportConfiguration(error)
      throw error
    })
    this.flights.set(id, flight)
    try { return await flight } finally { if (this.flights.get(id) === flight) this.flights.delete(id) }
  }
  private async create(id: string, project: Project, generation: object, signal: AbortSignal | undefined, isolated: boolean): Promise<SessionState> {
    const capability = async (dispatchSignal?: AbortSignal) => {
      const health = await this.client.request<{ capabilities?: { root_session_resume?: boolean; isolated_session_registration?: boolean } }>('/health', { signal: dispatchSignal })
      if (isolated ? health?.capabilities?.isolated_session_registration !== true : health?.capabilities?.root_session_resume !== true) {
        const required = isolated ? 'isolated_session_registration' : 'root_session_resume'
        throw new ConfigurationError(required, 'Engram ' + required + ' capability is required; upgrade Engram and restart serve')
      }
    }
    if (!isolated) await capability(signal)
    let ack: { id?: unknown; status?: unknown }
    try {
      ack = await this.client.request('/sessions', { method: 'POST', signal, ...(isolated ? { beforeDispatch: capability } : {}), body: {
        id, project: project.project, ...(isolated ? { isolated: true } : { directory: project.cwd }), ownership_mode: 'project_owned', resume: true, project_provenance: project.provenance,
      } })
    } catch (error) {
      if (error instanceof EngramHttpError && error.status === 409 && error.code === 'session_project_conflict') throw new SessionProjectConflictError()
      throw error
    }
    const effective = ack?.id
    const suffix = typeof effective === 'string' && effective.startsWith(`${id}:resume:`) ? effective.slice(`${id}:resume:`.length) : ''
    if (ack?.status !== 'created' || typeof effective !== 'string' || !(effective === id || /^[1-9]\d*$/.test(suffix))) throw new Error('Invalid Engram session registration acknowledgement')
    const state = { ...project, effectiveId: effective, registeredAt: this.now(), isolated }
    if (this.generations.get(id) !== generation) throw new Error('Engram session registration was invalidated during dispatch')
    this.states.set(id, state)
    return state
  }
  async write(id: string, project: Project, body: Record<string, unknown> | ((state: SessionState) => Record<string, unknown>), signal?: AbortSignal): Promise<unknown> {
    const state = await this.register(id, project, signal)
    return this.client.request('/observations', { method: 'POST', signal, body: {
      ...(typeof body === 'function' ? body(state) : body), session_id: state.effectiveId, project: state.project, project_provenance: project.provenance,
    } })
  }
  async end(id: string, project: Project, summary = '', signal?: AbortSignal, confirmed?: SessionState): Promise<unknown> {
    if (this.finalizations.has(id)) throw new Error('Session finalization is unresolved; explicitly confirm it before ending this session')
    const pending = this.endings.get(id)
    if (pending?.flight) return pending.flight
    const state = pending?.state ?? confirmed ?? await this.register(id, project, signal)
    const raced = this.endings.get(id)
    if (raced?.flight) return raced.flight
    const binding = raced ?? { state, uncertain: false }
    this.endings.set(id, binding)
    const flight = this.client.request<{ id?: unknown; status?: unknown }>(
      '/sessions/' + encodeURIComponent(binding.state.effectiveId) + '/end',
      { method: 'POST', signal, body: { summary, project_provenance: project.provenance } },
    ).then(result => {
      if (result?.id !== binding.state.effectiveId || result.status !== 'completed') throw new Error('Session end outcome is unknown; retry mem_session_end explicitly with the same host identity')
      this.invalidate(id); this.endings.delete(id)
      return result
    }).catch(error => {
      if (error instanceof EngramHttpError && error.status >= 400 && error.status < 500 && !binding.uncertain) this.endings.delete(id)
      else binding.uncertain = true
      throw error
    })
    binding.flight = flight
    try { return await flight } finally { binding.flight = undefined }
  }
  async finalize(id: string, project: Project, summary: string, signal?: AbortSignal, isolated = false): Promise<unknown> {
    let binding = this.finalizations.get(id)
    if (binding?.flight) return binding.flight
    if (!binding) {
      const state = await this.register(id, project, signal, false, isolated)
      binding = this.finalizations.get(id)
      if (binding?.flight) return binding.flight
      if (!binding) { binding = { state, uncertain: false }; this.finalizations.set(id, binding) }
    }
    const pinned = binding
    // Pi's finalization pins identity before dispatch. Unknown acknowledgement
    // stays closed; only an explicit retry may query Go's finalization journal.
    const flight = this.client.request<Record<string, unknown>>(
      '/sessions/' + encodeURIComponent(pinned.state.effectiveId) + '/finalize',
      { method: 'POST', signal, body: { project: pinned.state.project, summary } },
    ).then(result => {
      if (!result || result.session_id !== pinned.state.effectiveId
        || !['finalized', 'already_finalized'].includes(String(result.state))
        || !Number.isSafeInteger(result.summary_id) || Number(result.summary_id) < 1
        || typeof result.summary_sync_id !== 'string' || !result.summary_sync_id
        || result.already_finalized !== (result.state === 'already_finalized')) {
        throw new Error('Session finalization outcome is unknown; retry mem_session_finalize explicitly with the same host identity')
      }
      pinned.uncertain = false
      this.invalidate(id); this.finalizations.delete(id)
      return result
    }).catch(error => {
      const refused = error instanceof EngramHttpError && error.status >= 400 && error.status < 500 && error.code !== 'session_already_ended'
      if (refused && !pinned.uncertain) this.finalizations.delete(id)
      else pinned.uncertain = true
      throw error
    })
    pinned.flight = flight
    try { return await flight } finally { pinned.flight = undefined }
  }

}
