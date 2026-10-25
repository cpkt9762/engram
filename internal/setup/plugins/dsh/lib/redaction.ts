// Ported from plugin/pi/private-redaction.js. Explicit private blocks only;
// credential-shaped redaction remains the Go server's responsibility.
const PRIVATE_TAG_PATTERN = /<private>[\s\S]*?<\/private>/gi
export function redactPrivateTags(value: string): string {
  return value.replace(PRIVATE_TAG_PATTERN, '[REDACTED]')
}
export function redactUrlPath(path: string): string {
  const redacted = redactPrivateTags(path)
  const url = new URL(redacted, 'http://engram.local')
  const params = new URLSearchParams()
  for (const [key, value] of url.searchParams) params.append(key, redactPrivateTags(value))
  const query = params.toString()
  return `${url.pathname}${query ? '?' + query : ''}${url.hash}`
}
export function redactValue(value: unknown): unknown {
  if (typeof value === 'string') return redactPrivateTags(value)
  if (Array.isArray(value)) return value.map(redactValue)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactValue(entry)]))
  return value
}
