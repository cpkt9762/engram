import { redactPrivateTags } from './redaction.ts'

export class ConfigurationError extends Error {
  readonly diagnosticKey: string
  constructor(category: string, message: string, key = message) {
    super(message)
    this.name = 'ConfigurationError'
    this.diagnosticKey = `${category}:${key}`
  }
}
export interface DiagnosticLogger {
  warn(format: string, ...args: unknown[]): void
  error(format: string, ...args: unknown[]): void
}
export class Diagnostics {
  private logger: DiagnosticLogger
  private token: string
  private reported = new Set<string>()
  constructor(logger: DiagnosticLogger, token: string) { this.logger = logger; this.token = token }
  private safe(message: string): string {
    const redacted = redactPrivateTags(message)
    return this.token ? redacted.split(this.token).join('[REDACTED]') : redacted
  }
  warn(message: string): void {
    try { this.logger.warn('%s', this.safe(message)) } catch { /* Logs must not break host lifecycle. */ }
  }
  report(label: string, error: unknown): void {
    const message = this.safe(error instanceof Error ? error.message : String(error))
    if (error instanceof ConfigurationError) {
      if (this.reported.has(error.diagnosticKey)) return
      this.reported.add(error.diagnosticKey)
      try { this.logger.error(`${label}: %s`, message) } catch { /* Logs must not break host lifecycle. */ }
      return
    }
    try { this.logger.warn(`${label}: %s`, message) } catch { /* Logs must not break host lifecycle. */ }
  }
}
