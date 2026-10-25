// Ported from Pi postObservationWithReplayRecovery. The Go ledger alone decides
// whether a save committed; this exception applies only to native mem_save.
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { EngramHttpError, EngramUnknownOutcomeError } from './client.ts'
import type { Client } from './client.ts'
import { redactValue } from './redaction.ts'

interface Attempt { response?: Response; data?: unknown }
interface Timing { totalMs?: number; postMs?: number; getMs?: number; backoffMs?: number }
function receipt(value: unknown, lookup: boolean): boolean {
  const data = value as { id?: unknown; status?: unknown } | null
  return !!data && Number.isSafeInteger(data.id) && Number(data.id) > 0
    && (lookup ? data.status === 'committed' : data.status === undefined || data.status === 'saved')
}
export async function postObservationWithReplayRecovery(client: Client, body: Record<string, unknown>, signal?: AbortSignal, timing: Timing = {}): Promise<unknown> {
  signal?.throwIfAborted()
  await client.beforeDispatch?.(signal)
  const binding = client.binding?.(), endpoint = client.url, token = client.token
  const operation = randomUUID()
  const destinations = Object.freeze({ post: `${endpoint}/observations`, get: `${endpoint}/observations/save-result?${new URLSearchParams({ operation_id: operation })}` })
  const headers = Object.freeze({ ...client.headers('/observations') })
  const bytes = JSON.stringify({ ...redactValue(body) as Record<string, unknown>, operation_id: operation })
  const deadline = performance.now() + (timing.totalMs ?? 7500)
  // Neither logs nor thrown errors carry the operation UUID. All transport/body
  // ambiguity becomes a generic unknown result; never echo a fetch URL.
  const unknown = () => { throw new EngramUnknownOutcomeError() }
  const sanitize = (value: unknown): unknown => {
    if (typeof value === 'string') return value.split(operation).join('[REDACTED]')
    if (Array.isArray(value)) return value.map(sanitize)
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key.split(operation).join('[REDACTED]'), sanitize(entry)]))
    return value
  }
  const httpError = (attempt: Attempt) => new EngramHttpError(attempt.response!.status, sanitize(attempt.data ?? null))
  async function attempt(method: 'POST' | 'GET'): Promise<Attempt> {
    signal?.throwIfAborted()
    const remaining = deadline - performance.now()
    if (remaining <= 0) return {}
    const controller = new AbortController()
    let stop: (error: unknown) => void = () => {}
    const stopped = new Promise<never>((_resolve, reject) => { stop = reject })
    const abort = () => { controller.abort(signal?.reason); stop(signal?.reason) }
    const timer = setTimeout(() => { controller.abort(); stop(new Error('Save recovery deadline reached')) }, Math.min(remaining, method === 'POST' ? timing.postMs ?? 3000 : timing.getMs ?? 1000))
    signal?.addEventListener('abort', abort, { once: true })
    try {
      const exchange = async (): Promise<Attempt> => {
        await client.beforeDispatch?.(controller.signal)
        controller.signal.throwIfAborted()
        if (client.url !== endpoint || client.token !== token || client.binding?.() !== binding) return {}
        const response = await (client.options.fetch ?? fetch)(method === 'POST' ? destinations.post : destinations.get, { method, headers, body: method === 'POST' ? bytes : undefined, signal: controller.signal })
        if (response.status === 204) return { response, data: null }
        try { return { response, data: await response.json() } }
        catch { signal?.throwIfAborted(); return { response } }
      }
      return await Promise.race([exchange(), stopped])
    } catch { signal?.throwIfAborted(); return {} }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); controller.abort() }
  }
  const initial = await attempt('POST')
  if (initial.response?.ok && receipt(initial.data, false)) return initial.data
  if (initial.response && !initial.response.ok) throw httpError(initial)
  const lookup = await attempt('GET')
  if (lookup.response?.ok && receipt(lookup.data, true)) return lookup.data
  const miss = lookup.data as { code?: unknown; error?: unknown } | null
  if (lookup.response?.status !== 404 || miss?.code !== 'observation_save_result_not_found' || miss.error !== 'no committed result found for operation_id') return unknown()
  signal?.throwIfAborted()
  const remaining = deadline - performance.now(), backoff = timing.backoffMs ?? 250
  if (remaining <= backoff) return unknown()
  try { await delay(backoff, undefined, { signal }) } catch (error) { signal?.throwIfAborted(); throw error }
  const replay = await attempt('POST')
  if (replay.response?.ok && receipt(replay.data, false)) return replay.data
  if (replay.response && !replay.response.ok && ![409, 410].includes(replay.response.status)) throw httpError(replay)
  const final = await attempt('GET')
  if (final.response?.ok && receipt(final.data, true)) return final.data
  return unknown()
}
