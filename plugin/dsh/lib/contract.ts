import { readFileSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { hasErrorCode, EngramUnavailableError } from './client.ts'
import { ConfigurationError } from './diagnostics.ts'
import type { Client } from './client.ts'

const expected = JSON.parse(readFileSync(new URL('../runtime-contract.json', import.meta.url), 'utf8'))
export class RuntimeContractError extends ConfigurationError {
  constructor(reason: string) {
    super('runtime-contract', `engram-dsh rejected the Engram runtime contract: ${reason}. Expected ${expected.contract_id}. Upgrade Engram and restart serve and DSH. 升级 Engram、重启 serve 和 DSH。Memory dispatch was blocked.`)
    this.name = 'RuntimeContractError'
  }
}
// Ported from plugin/pi/runtime-contract.js: compare the entire Go projection,
// excluding only bounded instance_id. Never infer authority from a digest or version.
export function runtimeContractIdentity(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RuntimeContractError('malformed contract')
  const { instance_id, ...projection } = value as Record<string, unknown>
  if (typeof instance_id !== 'string' || !instance_id.trim() || instance_id.length > 128) throw new RuntimeContractError('missing or malformed instance identity')
  if (!isDeepStrictEqual(projection, expected)) throw new RuntimeContractError('projection mismatch')
  return instance_id
}
export class Contract {
  readonly client: Client
  readonly localId: () => string | undefined
  private accepted?: string
  constructor(client: Client, localId: () => string | undefined = () => undefined) { this.client = client; this.localId = localId }
  get identity(): string | undefined { return this.accepted }
  async check(signal?: AbortSignal): Promise<void> {
    const timeout = AbortSignal.timeout(3000)
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    try {
      const res = await fetch(`${this.client.url}/runtime-contract`, { headers: this.client.headers('/runtime-contract'), signal: signal ? AbortSignal.any([timeout, signal]) : timeout })
      if (!res.ok || !res.body) throw new RuntimeContractError('missing or unavailable contract')
      reader = res.body.getReader()
      const chunks: Uint8Array[] = []
      let size = 0
      for (;;) {
        const item = await reader.read()
        if (item.done) break
        size += item.value.byteLength
        if (size > 65536) throw new RuntimeContractError('oversized response (64 KiB limit)')
        chunks.push(item.value)
      }
      const identity = runtimeContractIdentity(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      if (this.localId() && identity !== this.localId()) throw new RuntimeContractError('local instance mismatch')
      if (this.accepted && identity !== this.accepted) throw new RuntimeContractError('server identity changed; restart DSH')
      this.accepted = identity
    } catch (error) {
      signal?.throwIfAborted()
      if (hasErrorCode(error, 'ECONNREFUSED')) throw new EngramUnavailableError()
      if (error instanceof RuntimeContractError) throw error
      throw new RuntimeContractError('unreadable or incompatible contract')
    } finally { await reader?.cancel().catch(() => {}) }
  }
}
