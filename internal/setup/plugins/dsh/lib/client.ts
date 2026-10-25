import { setTimeout as delay } from 'node:timers/promises'
import type { Config } from './config.ts'
import { redactUrlPath, redactValue } from './redaction.ts'

export class EngramHttpError extends Error {
  readonly status: number
  readonly code: string | undefined
  readonly data: unknown
  constructor(status: number, data: unknown) {
    const body = data as { error?: unknown; code?: unknown } | null
    super(typeof body?.error === 'string' ? body.error : `Engram request failed with HTTP ${status}`)
    this.name = 'EngramHttpError'; this.status = status; this.data = data
    this.code = typeof body?.code === 'string' ? body.code : undefined
  }
}
export class EngramUnavailableError extends Error {
  constructor() { super('Engram connection refused. Start Engram or verify ENGRAM_URL/ENGRAM_BIN.'); this.name = 'EngramUnavailableError' }
}
export class EngramUnknownOutcomeError extends Error {
  constructor() {
    super('Engram write outcome is unknown; it may already have been saved. Use mem_search to verify before retrying. 可能已经写入，先用 mem_search 核实，不要直接重试。')
    this.name = 'EngramUnknownOutcomeError'
  }
}
export function hasErrorCode(error: unknown, code: string, depth = 0): boolean {
  if (!error || typeof error !== 'object' || depth > 5) return false
  const item = error as { code?: unknown; cause?: unknown; errors?: unknown[] }
  return item.code === code || hasErrorCode(item.cause, code, depth + 1) || (Array.isArray(item.errors) && item.errors.some(e => hasErrorCode(e, code, depth + 1)))
}
export function fetchPolicy(path: string, method: string) {
  if (method === 'POST' && path === '/sessions') return { timeoutMs: 5000, maxAttempts: 2, write: true }
  if (method === 'GET') return { timeoutMs: path.startsWith('/doctor') ? 15000 : 10000, maxAttempts: 3, write: false }
  return { timeoutMs: 3000, maxAttempts: 1, write: true }
}
export interface RequestOptions { method?: string; body?: unknown; signal?: AbortSignal; beforeDispatch?: (signal?: AbortSignal) => Promise<void> }
export interface ClientOptions {
  timeoutMs?: number
  backoffMs?: number
  fetch?: typeof fetch
}
export class Client {
  readonly url: string
  readonly token: string
  binding?: () => unknown
  beforeDispatch?: (signal?: AbortSignal) => Promise<void>
  onUnavailable?: () => void
  readonly options: ClientOptions
  constructor(config: Config, options: ClientOptions = {}) {
    this.url = config.url ?? `http://127.0.0.1:${config.port}`
    this.token = config.token; this.options = options
  }
  headers(path: string): Record<string, string> {
    return { 'Content-Type': 'application/json', ...(path !== '/health' && this.token ? { Authorization: `Bearer ${this.token}` } : {}) }
  }
  async request<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
    const method = opts.method ?? 'GET', policy = fetchPolicy(path, method)
    let ambiguous = false
    for (let attempt = 0; attempt < policy.maxAttempts; attempt++) {
      opts.signal?.throwIfAborted()
      await this.beforeDispatch?.(opts.signal)
      await opts.beforeDispatch?.(opts.signal)
      // Qualification failures are never transport failures and must not be retried here.
      let response: Response | undefined
      try {
        const timeout = AbortSignal.timeout(this.options.timeoutMs ?? policy.timeoutMs)
        response = await (this.options.fetch ?? fetch)(`${this.url}${redactUrlPath(path)}`, {
          method, headers: this.headers(path), body: opts.body === undefined ? undefined : JSON.stringify(redactValue(opts.body)),
          signal: opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout,
        })
        const data = response.status === 204 ? null : await response.json()
        if (!response.ok) throw new EngramHttpError(response.status, data)
        return data as T
      } catch (error) {
        if (error instanceof EngramHttpError) throw error
        if (response && !response.ok) throw new EngramHttpError(response.status, null)
        // A cancelled dispatched write may still have committed; never replay it.
        if (opts.signal?.aborted) {
          if (policy.write) throw new EngramUnknownOutcomeError()
          opts.signal.throwIfAborted()
        }
        const refused = hasErrorCode(error, 'ECONNREFUSED')
        if (error instanceof SyntaxError && !policy.write) throw error
        const preDispatch = ['ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'ERR_INVALID_URL'].some(code => hasErrorCode(error, code))
        ambiguous ||= !refused && !preDispatch
        if (attempt + 1 === policy.maxAttempts) {
          if (policy.write && ambiguous) throw new EngramUnknownOutcomeError()
          if (refused) { this.onUnavailable?.(); throw new EngramUnavailableError() }
          throw new Error('Engram request failed or timed out')
        }
        try { await delay((this.options.backoffMs ?? 250) * 2 ** attempt, undefined, { signal: opts.signal }) }
        catch (error) { opts.signal?.throwIfAborted(); throw error }
      }
    }
    throw new Error('Engram request exhausted attempts')
  }
}
