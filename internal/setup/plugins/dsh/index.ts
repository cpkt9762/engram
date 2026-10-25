import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { parseConfig } from './lib/config.ts'
import { Runtime } from './lib/runtime.ts'
import { createTools } from './lib/tools.ts'
import { MEMORY_INSTRUCTIONS } from './lib/protocol.ts'

export const name = 'engram-dsh'
export const inject = ['tools', 'systemPrompt']
export function apply(ctx: Context, config: unknown): void {
  const settings = parseConfig(config)
  const logger = ctx.logger('engram-dsh')
  const runtime = new Runtime(settings, Date.now, logger)
  const report = (label: string, error: unknown) => runtime.report(label, error)
  const tools = createTools(runtime)
  for (const definition of tools) ctx.tools.register(definition)
  const ownTools = new Set(tools.map(tool => tool.name))
  ctx.systemPrompt.section({ name: 'engram-dsh:memory-protocol', order: 9950, interpolate: false, text: MEMORY_INSTRUCTIONS })
  ctx.systemPrompt.context({ name: 'engram-dsh:compaction-recovery', order: 130, text: context => runtime.compaction.notice(context.agent?.id) })
  ctx.effect(() => () => runtime.close(), 'engram-dsh.runtime')
  ctx.on('agent/created', payload => {
    try { void runtime.prepare(payload.agent).catch(error => { report('Engram warmup failed', error) }) }
    catch (error) { report('Engram warmup failed', error) }
    return undefined
  })
  ctx.on('agent/inbox/inserted', payload => {
    try { runtime.capture.inbox(payload.agent, payload.message) }
    catch (error) { report('Engram inbox capture failed', error) }
    return undefined
  })
  ctx.on('tools/result', (exec, result) => {
    try { runtime.capture.result(exec, result, ownTools) }
    catch (error) { report('Engram tool capture failed', error) }
    return undefined
  })
  ctx.on('session/event', (session, event) => {
    try { runtime.compaction.event(session, event) }
    catch (error) { report('Engram compaction capture failed', error) }
    return undefined
  })
  ctx.on('agent/turn-stopping', payload => {
    try {
      const id = payload.agent.id
      runtime.capture.endTurn(id)
      return runtime.queue.drain(id).then(() => { runtime.compaction.clearDelivered(id) })
        .catch(error => { report('Engram queue drain failed', error) })
    } catch (error) { report('Engram queue drain failed', error); return undefined }
  })
  ctx.on('agent/disposed', payload => {
    try { runtime.dispose(payload.agent.id) }
    catch (error) { report('Engram disposal failed', error) }
    return undefined
  })
}
