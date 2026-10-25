import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { Runtime } from './runtime.ts'
import type { Agent } from './project.ts'
import { extraSchemas } from './tool-schemas.ts'
import { validate, omitBlankOptionalStrings } from './validation.ts'
import { ConfigurationError } from './diagnostics.ts'
import { dispatchExtra } from './tool-dispatch.ts'

const str = (description: string) => ({ type: 'string' as const, description })
const bool = (description: string) => ({ type: 'boolean' as const, description })
const scope = { ...str('Filter by scope: project, personal, or global. Omit to apply no scope filter.'), enum: ['project', 'personal', 'global'] }
// Standard JSON Schema transcription of Pi MEMORY_TOOL_SCHEMAS; DSH does not
// validate bare ToolDefinition arguments, so validation below is mandatory.
export const schemas = {
  ...extraSchemas,
  mem_current_project: { type: 'object', properties: { cwd: str('Working directory assertion; must match this agent session cwd') }, required: [] },
  mem_save: { type: 'object', properties: {
    title: str('Short, searchable title'),
    content: str('Structured memory content. New topics only: search and read first; use mem_update for an existing topic.'),
    type: str('Observation type/category'), scope,
    topic_key: str('Stable, deliberate topic key; reuse via mem_update rather than duplicating'),
    project: str('Optional explicit project'),
    cwd: str('Optional directory whose Engram project receives this write; must agree with project when both are set'),
    capture_prompt: bool('Capture the available session/project prompt for this save (default true); does not disable lifecycle capture'),
  }, required: ['title', 'content'] },
  mem_search: { type: 'object', properties: {
    query: str('Search query — natural language or keywords. Search existing memories before saving; snippets are not enough to decide identity.'),
    type: str('Filter by observation type'), project: str('Filter by project name'), scope,
    limit: { type: 'number', description: 'Max results' },
    all_projects: bool('Search across every project; when true project is ignored'),
    match_mode: { ...str('Match mode: all (default) or any for broader recall'), enum: ['all', 'any'] },
    response_format: { ...str('Response format: compact for previews and metadata; omit for the existing full response'), enum: ['compact'] },
  }, required: ['query'] },
  mem_context: { type: 'object', properties: {
    project: str('Filter by project'), scope,
    max_bytes: { type: 'integer', minimum: 1, description: 'Maximum context output size in bytes; must be a positive integer; enforced by Engram core' },
    compact: bool("Use Engram core's compact context formatting"),
    older_history: bool('Include a bounded Older History overview with counts and sampled titles outside the recent window'),
    all_projects: bool('Explicitly read context across every project; when true project is ignored'),
  }, required: [] },
} as const
export type ToolName = keyof typeof schemas
export function validateArgs(name: ToolName, raw: unknown): Record<string, unknown> {
  const normalized = omitBlankOptionalStrings(schemas[name], raw)
  // Explicit mem_update exception: empty/whitespace replacement is literal data
  // when find is nonblank. Keep schemas standard for model providers.
  if (name === 'mem_update' && raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const input = raw as Record<string, unknown>
    if (typeof input.find === 'string' && input.find.trim() && Object.hasOwn(input, 'replace')) {
      (normalized as Record<string, unknown>).replace = input.replace
    }
  }
  const args = validate(schemas[name], normalized)
  if (name === 'mem_update' && (typeof args.find !== 'string' || !args.find.trim())) delete args.replace
  const errors: string[] = []
  if (name === 'mem_search_prompts' && args.project !== undefined && args.all_projects === true) errors.push('project cannot be combined with all_projects=true')
  if (errors.length) throw new Error('invalid arguments: ' + errors.join('; '))
  return args
}

function query(params: Record<string, unknown>): string {
  const entries = Object.entries(params).filter(([, value]) => value !== undefined).map(([key, value]): [string, string] => [key, String(value)])
  return `?${new URLSearchParams(entries).toString()}`
}
export function createTools(runtime: Runtime): ToolDefinition[] {
  return (Object.keys(schemas) as ToolName[]).map(name => ({
    name,
    description: `Engram memory tool: ${name.slice(4).replaceAll('_', ' ')}. Persistence is handled by Engram when installed and running.`,
    parameters: schemas[name] as unknown as ToolDefinition['parameters'],
    output: { schema: name === 'mem_search'
      ? { oneOf: [{ type: 'object', additionalProperties: true }, { type: 'array', items: { type: 'object', additionalProperties: true } }] }
      : name === 'mem_search_prompts' ? { type: 'array', items: { type: 'object', additionalProperties: true } } : { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
    async execute(raw, exec) {
      const args = validateArgs(name, raw)
      if (!exec.agent) throw new Error('Engram tools require exec.agent')
      const agent = exec.agent as unknown as Agent
      const dispatch = async () => {
        const project = await runtime.prepare(agent, exec.signal)
        const target = await runtime.satellites.resolve(name, agent, project, args, exec.signal).catch(error => {
          if (error instanceof ConfigurationError) runtime.report('Engram explicit project resolution failed', error)
          throw error
        })
        if (name === 'mem_current_project' && args.cwd !== undefined && args.cwd !== project.cwd) throw new Error('cwd must match agent.session.header.cwd')
        if (name === 'mem_current_project') return project.response
        if (name === 'mem_save') {
          return runtime.save(target, state => {
            const current = args.capture_prompt === false ? undefined : runtime.capture.current(agent.id, target.project.project, state.effectiveId)
            return {
              title: args.title, content: args.content, type: args.type || 'manual', scope: args.scope || 'project',
              topic_key: args.topic_key, capture_prompt: args.capture_prompt, ...(current ? { current_prompt: current } : {}),
            }
          }, exec.signal)
        }
        if (name in extraSchemas) return dispatchExtra(name, args, runtime, agent, project, exec.signal, target)
        const selected = args.all_projects === true ? undefined : args.project ?? project.project
        if (name === 'mem_search') return runtime.client.request(`/search${query({
          q: args.query, project: selected, type: args.type, scope: args.scope, limit: args.limit,
          match_mode: args.match_mode, response_format: args.response_format, all_projects: args.all_projects,
        })}`, { signal: exec.signal })
        return runtime.client.request(`/context${query({
          project: selected, scope: args.scope, max_bytes: args.max_bytes, compact: args.compact,
          older_history: args.older_history, all_projects: args.all_projects,
        })}`, { signal: exec.signal })
      }
      const writes = ['mem_save', 'mem_save_prompt', 'mem_session_summary', 'mem_capture_passive', 'mem_session_start', 'mem_session_end', 'mem_session_finalize', 'mem_update', 'mem_pin', 'mem_unpin', 'mem_judge', 'mem_judge_many', 'mem_compare', 'mem_consolidate']
      return writes.includes(name) || (name === 'mem_review' && args.action === 'mark_reviewed')
        ? runtime.queue.run(agent.id, dispatch, exec.signal) : dispatch()
    },
  }))
}
