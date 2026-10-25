import type { Runtime } from './runtime.ts'
import type { Agent } from './project.ts'
import { textBlocks } from './capture.ts'
import { redactPrivateTags } from './redaction.ts'
import { EngramUnknownOutcomeError } from './client.ts'

export type ArchiveOutcome = 'confirmed' | 'unknown' | 'failed' | 'unavailable'
// Adapted from Pi compaction-recovery.js. Static notices intentionally contain
// neither user summary/context nor project names: strict context interpolation
// must never interpret user-provided double braces.
const notices: Record<ArchiveOutcome, string> = {
  confirmed: 'Compaction recovery summary was already saved to Engram by engram-dsh. No manual mem_session_summary call is needed for this compaction. Call mem_context if you need additional recent project memory.',
  unknown: 'Compaction recovery could not confirm whether the summary was saved to Engram. Do NOT retry or call mem_session_summary yet, because that could duplicate the summary. First verify with mem_search or mem_doctor; save the summary once only if it is absent.',
  failed: 'CRITICAL INSTRUCTION FOR COMPACTED SUMMARY:\nThe agent has access to Engram persistent memory via native DSH tools when engram-dsh is active. FIRST ACTION REQUIRED: Call mem_session_summary with the content of this compacted summary for the verified current project. This preserves what was accomplished before compaction. Do this BEFORE any other work. If mem_session_summary is unavailable, manually save this compacted summary once Engram tools are available.',
  unavailable: 'CRITICAL INSTRUCTION FOR COMPACTED SUMMARY:\nengram-dsh could not safely confirm the runtime session and project, so it did not archive the summary. Before saving manually, verify the active Engram session and project with mem_current_project or mem_doctor. Save the summary once only after that verification.',
}
export function recoveryNotice(outcome: ArchiveOutcome): string { return notices[outcome] }
export class Compaction {
  private runtime: Runtime
  private seen = new Set<string>()
  private generations = new Map<string, object>()
  private pending = new Map<string, { text: string; delivered: boolean }>()
  constructor(runtime: Runtime) { this.runtime = runtime }
  event(session: Agent['session'] & { id: string }, event: unknown): void {
    const input = event as { type?: string; data?: { compactionId?: unknown; summary?: unknown } } | null
    if (input?.type !== 'compaction/summary' || typeof input.data?.compactionId !== 'string' || !input.data.compactionId) return
    const summary = redactPrivateTags(textBlocks(input.data.summary)).trim()
    if (!summary) return
    const key = `${session.id}\0${input.data.compactionId}`
    if (this.seen.has(key)) return
    this.seen.add(key)
    if (this.seen.size > 256) this.seen.delete(this.seen.values().next().value!)
    const generation = this.generations.get(session.id) ?? {}
    this.generations.set(session.id, generation)
    const agent = { id: session.id, session }
    this.runtime.queue.enqueue(session.id, async () => {
      let outcome: ArchiveOutcome = 'unavailable'
      try {
        const project = await this.runtime.prepare(agent)
        await this.runtime.sessions.register(agent.id, project)
        try {
          const receipt = await this.runtime.sessions.write(agent.id, project, {
            type: 'session_summary', title: 'Compaction recovery summary', content: summary,
            scope: 'project', topic_key: 'session/compaction-recovery',
          }) as { id?: unknown; status?: unknown } | null
          outcome = receipt && Number.isSafeInteger(receipt.id) && Number(receipt.id) > 0 && receipt.status === 'saved' ? 'confirmed' : 'unknown'
        } catch (error) {
          outcome = error instanceof EngramUnknownOutcomeError ? 'unknown' : 'failed'
          this.runtime.report(`Engram compaction archive ${outcome}`, error)
        }
      } catch (error) { this.runtime.report('Engram compaction unavailable', error) }
      if (this.generations.get(session.id) === generation) this.pending.set(session.id, { text: recoveryNotice(outcome), delivered: false })
    })
  }
  notice(id: string | undefined): string {
    const entry = id ? this.pending.get(id) : undefined
    if (!entry) return ''
    entry.delivered = true
    return entry.text
  }
  clearDelivered(id: string): void { if (this.pending.get(id)?.delivered) this.pending.delete(id) }
  dispose(id: string): void {
    this.generations.delete(id); this.pending.delete(id)
    for (const key of this.seen) if (key.startsWith(`${id}\0`)) this.seen.delete(key)
  }
  close(): void { this.seen.clear(); this.pending.clear(); this.generations.clear() }
}
