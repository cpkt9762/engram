export interface Config { url?: string; port: number; engramBin: string; token: string }

function optionalEnvironmentValue(value: string | undefined): string | undefined {
  return value?.trim() || undefined
}
// Keep this exact declaration compatible with internal/setup.patchEngramBINLine.
const ENGRAM_BIN = optionalEnvironmentValue(process.env.ENGRAM_BIN) ?? "engram"

export function parseConfig(raw: unknown, env: NodeJS.ProcessEnv = process.env): Config {
  if (raw !== undefined && (raw === null || typeof raw !== 'object' || Array.isArray(raw))) throw new Error('config must be an object')
  const input = (raw ?? {}) as Record<string, unknown>
  const string = (key: string, value: unknown): string | undefined => {
    if (value === undefined) return undefined
    if (typeof value !== 'string' || !value.trim()) throw new Error(`${key} must be a non-empty string`)
    return value.trim()
  }
  const url = string('url', input.url ?? optionalEnvironmentValue(env.ENGRAM_URL))
  if (url) {
    let parsed: URL
    try { parsed = new URL(url) } catch { throw new Error('url must be an HTTP(S) URL') }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('url must be an HTTP(S) URL without credentials, query or fragment')
  }
  const portInput = input.port ?? optionalEnvironmentValue(env.ENGRAM_PORT) ?? 7437
  if (input.port !== undefined && typeof input.port !== 'number') throw new Error('port must be an integer')
  const port = typeof portInput === 'string' && /^\d+$/.test(portInput) ? Number(portInput) : portInput
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('port must be an integer from 1 to 65535')
  const engramBin = string('engramBin', input.engramBin ?? optionalEnvironmentValue(env.ENGRAM_BIN)) ?? ENGRAM_BIN
  return { url: url?.replace(/\/+$/, ''), port, engramBin, token: env.ENGRAM_HTTP_TOKEN ?? '' }
}
