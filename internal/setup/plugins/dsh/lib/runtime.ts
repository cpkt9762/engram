import { Client, EngramUnavailableError } from './client.ts'
import { Contract } from './contract.ts'
import { Projects, agentCwd } from './project.ts'
import type { Agent } from './project.ts'
import { Server } from './server.ts'
import { Satellites } from './satellite.ts'
import type { WriteTarget } from './satellite.ts'
import type { SessionState } from './session.ts'
import { postObservationWithReplayRecovery } from './save-recovery.ts'
import { Sessions } from './session.ts'
import { WriteQueues } from './queue.ts'
import { Capture } from './capture.ts'
import { Compaction } from './compaction.ts'
import { ConfigurationError, Diagnostics } from './diagnostics.ts'
import type { DiagnosticLogger } from './diagnostics.ts'
import type { Config } from './config.ts'

export class Runtime {
  readonly queue: WriteQueues
  readonly capture: Capture
  readonly compaction: Compaction
  readonly warn: (message: string) => void
  readonly report: (label: string, error: unknown) => void
  private closed = false
  readonly client: Client
  readonly server: Server
  readonly contract: Contract
  readonly projects: Projects
  readonly sessions: Sessions
  readonly satellites: Satellites
  constructor(config: Config, now = Date.now, logger: DiagnosticLogger = { warn() {}, error() {} }) {
    const diagnostics = new Diagnostics(logger, config.token)
    this.warn = message => diagnostics.warn(message)
    this.report = (label, error) => diagnostics.report(label, error)
    this.queue = new WriteQueues(this.warn, error => this.report('Engram queued capture failed', error))
    this.capture = new Capture(this)
    this.compaction = new Compaction(this)
    this.client = new Client(config)
    this.server = new Server(config, now)
    this.contract = new Contract(this.client, () => this.server.localId)
    this.projects = new Projects(this.client, now)
    this.sessions = new Sessions(this.client, now, error => this.report('Engram session registration failed', error))
    this.satellites = new Satellites(this.client, this.sessions, this.projects)
    this.client.binding = () => this.contract.identity
    this.client.onUnavailable = () => this.server.reset()
    this.client.beforeDispatch = signal => this.qualify(signal)
  }
  private async qualify(signal?: AbortSignal): Promise<void> {
    if (this.closed) throw new Error('Engram plugin was unloaded')
    signal?.throwIfAborted()
    try {
      await this.server.ensure()
      signal?.throwIfAborted()
      await this.contract.check(signal)
    } catch (error) {
      if (error instanceof ConfigurationError) this.report('Engram runtime qualification failed', error)
      if (error instanceof EngramUnavailableError) this.server.reset()
      throw error
    }
  }
  async prepare(agent: Agent, signal?: AbortSignal) {
    const cwd = agentCwd(agent)
    if (typeof agent.id !== 'string' || !agent.id) throw new Error('DSH agent.id is required')
    await this.qualify(signal)
    try { return await this.projects.resolve(cwd, signal) }
    catch (error) {
      if (error instanceof ConfigurationError) this.report('Engram project resolution failed', error)
      throw error
    }
  }
  async save(target: WriteTarget, body: (state: SessionState) => Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const state = await this.satellites.register(target, signal)
    return postObservationWithReplayRecovery(this.client, { ...body(state), session_id: state.effectiveId, project: state.project, project_provenance: target.project.provenance }, signal)
  }
  dispose(id: string): void {
    this.satellites.dispose(id); this.queue.dispose(id); this.capture.endTurn(id); this.compaction.dispose(id); this.sessions.dispose(id)
  }
  close(): void {
    this.closed = true; this.satellites.close(); this.queue.close(); this.capture.close(); this.compaction.close()
    for (const id of this.sessions.states.keys()) this.sessions.dispose(id)
  }
}
