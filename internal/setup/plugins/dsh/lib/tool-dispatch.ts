import type { Runtime } from './runtime.ts'
import type { Agent, Project } from './project.ts'
import type { WriteTarget } from './satellite.ts'
import { callerProjection } from './doctor.ts'

function query(params: Record<string, unknown>): string {
  return '?' + new URLSearchParams(Object.entries(params).filter(([, value]) => value !== undefined).map(([key, value]): [string, string] => [key, String(value)])).toString()
}
function owner(args: Record<string, unknown>, project: Project): void {
  if (args.project !== undefined && args.project !== project.project) throw new Error('Review writes require the current project')
}
export async function dispatchExtra(name: string, args: Record<string, unknown>, runtime: Runtime, agent: Agent, project: Project, signal: AbortSignal | undefined, target: WriteTarget): Promise<unknown> {
  const request = <T = unknown>(path: string, method = 'GET', body?: unknown) => runtime.client.request<T>(path, { method, body, signal })
  const registered = () => runtime.sessions.register(agent.id, project, signal)
  const scoped = args.project ?? project.project
  switch (name) {
    case 'mem_search_prompts':
      return request(`/prompts/search${query({ q: args.query, project: args.all_projects ? undefined : scoped, all_projects: args.all_projects, limit: args.limit })}`)
    case 'mem_get_observation':
      return request(`/observations/${encodeURIComponent(String(args.id))}${query({ include_history: args.include_history, history_cursor: args.history_cursor })}`)
    case 'mem_update': {
      const { id, expected_project, ...body } = args
      return request(`/observations/${encodeURIComponent(String(id))}${query({ expected_project })}`, 'PATCH', body)
    }
    case 'mem_suggest_topic_key':
      return request('/topic-keys/suggest', 'POST', args)
    case 'mem_consolidate':
      return request('/observations/consolidate', 'POST', args)
    case 'mem_session_summary':
      return runtime.satellites.write(target, '/observations', { type: 'session_summary', title: 'Session summary', content: args.content, scope: 'project' }, signal)
    case 'mem_save_prompt': {
      const response = await runtime.satellites.write(target, '/prompts', { content: args.content }, signal) as { id: number }
      return { prompt_id: response.id, status: 'saved' }
    }
    case 'mem_capture_passive': {
      const state = await registered()
      return request('/observations/passive', 'POST', { session_id: state.effectiveId, project: project.project, content: args.content, source: args.source || 'dsh-tool', project_provenance: project.provenance })
    }
    case 'mem_session_start': {
      if (args.id !== undefined && args.id !== agent.id) throw new Error('Session id must match the current DSH agent')
      if (args.directory !== undefined && args.directory !== project.cwd) throw new Error('Session directory must match agent.session.header.cwd')
      const state = await registered()
      return { id: state.effectiveId, project: state.project, status: 'created' }
    }
    case 'mem_session_end':
      if (args.id !== undefined && args.id !== agent.id) throw new Error('Session id must match the current DSH agent')
      return runtime.satellites.endRoot(agent, project, args.summary as string | undefined, signal)
    case 'mem_session_finalize':
      return runtime.satellites.finalize(target, args.summary as string, signal)
    case 'mem_doctor': {
      const report = await request<Record<string, unknown>>(`/doctor${query({ project: scoped, check: args.check })}`)
      const state = runtime.sessions.states.get(agent.id)
      const caller = await request('/doctor/caller-binding', 'POST', {
        project: scoped, runtime_session_id: agent.id,
        ...(state?.project === scoped ? { effective_session_id: state.effectiveId } : {}),
        host_context: { append_entry_available: false, branch_available: false },
      })
      return { ...report, caller_binding: callerProjection(caller) }
    }
    case 'mem_review':
      if (args.action === 'list') return request(`/review${query({ project: args.all_projects ? undefined : scoped, limit: args.limit, all_projects: args.all_projects })}`)
      if (args.action !== 'mark_reviewed') throw new Error('invalid arguments: action must be list or mark_reviewed')
      if (args.all_projects) throw new Error('invalid arguments: all_projects is only supported for review list')
      owner(args, project)
      return request(`/review/mark_reviewed${query({ project: scoped })}`, 'POST', { observation_id: args.observation_id || args.id })
    case 'mem_judge':
      return request('/conflicts/judge', 'POST', { ...args, session_id: args.session_id || agent.id })
    case 'mem_judge_many':
      return request('/conflicts/judge-many', 'POST', args)
    case 'mem_compare':
      return request('/conflicts/compare', 'POST', args)
    case 'mem_list_projects':
      return request('/projects')
    case 'mem_pin':
    case 'mem_unpin':
      return request(`/observations/${encodeURIComponent(String(args.id))}/pin`, name === 'mem_pin' ? 'PUT' : 'DELETE')
    default: throw new Error(`Unsupported Engram memory tool: ${name}`)
  }
}
