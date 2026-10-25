import type { Runtime } from './runtime.ts'
import type { Agent } from './project.ts'
import { redactPrivateTags } from './redaction.ts'

export function textBlocks(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content.filter(block => block && block.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n')
}
export function isSubagent(agent: Agent): boolean {
  const header = agent.session.header
  return header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0
}
interface Prompt { turn: object; content: string; project: string; effectiveId: string }
export class Capture {
  private runtime: Runtime
  private turns = new Map<string, object>()
  private prompts = new Map<string, Prompt>()
  constructor(runtime: Runtime) { this.runtime = runtime }
  inbox(agent: Agent, message: unknown): void {
    if (isSubagent(agent)) return
    const input = message as { source?: { kind?: string }; content?: unknown } | null
    if (input?.source?.kind !== 'user') return
    const turn = {}
    this.turns.set(agent.id, turn); this.prompts.delete(agent.id)
    // Redact before truncation so a private block crossing 2000 chars stays private.
    const text = redactPrivateTags(textBlocks(input.content)).trim()
    if (text.length <= 10) return
    const content = text.slice(0, 2000)
    this.runtime.queue.enqueue(agent.id, async () => {
      const project = await this.runtime.prepare(agent)
      const state = await this.runtime.sessions.register(agent.id, project)
      if (this.turns.get(agent.id) === turn) this.prompts.set(agent.id, { turn, content, project: project.project, effectiveId: state.effectiveId })
      await this.runtime.client.request('/prompts', { method: 'POST', body: {
        session_id: state.effectiveId, content, project: project.project, project_provenance: project.provenance,
      } })
    })
  }
  result(exec: { name: string; parent?: unknown; agent?: Agent }, result: { isError?: boolean; content?: unknown }, ownTools: ReadonlySet<string>): void {
    if (ownTools.has(exec.name) || exec.parent != null || result.isError || !exec.agent || isSubagent(exec.agent)) return
    const content = redactPrivateTags(textBlocks(result.content))
    if (content.length <= 50) return
    const agent = exec.agent
    this.runtime.queue.enqueue(agent.id, async () => {
      const project = await this.runtime.prepare(agent)
      const state = await this.runtime.sessions.register(agent.id, project)
      await this.runtime.client.request('/observations/passive', { method: 'POST', body: {
        session_id: state.effectiveId, content, project: project.project, source: exec.name, project_provenance: project.provenance,
      } })
    })
  }
  current(id: string, project: string, effectiveId: string): string | undefined {
    const prompt = this.prompts.get(id)
    return prompt && prompt.turn === this.turns.get(id) && prompt.project === project && prompt.effectiveId === effectiveId ? prompt.content : undefined
  }
  endTurn(id: string): void { this.turns.delete(id); this.prompts.delete(id) }
  close(): void { this.turns.clear(); this.prompts.clear() }
}
