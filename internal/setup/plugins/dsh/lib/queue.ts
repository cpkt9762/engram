interface Item {
  job: () => Promise<unknown>
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
  unwatch: () => void
}
interface State { items: Item[]; running: boolean; closed: boolean; idle: Set<() => void> }
export class WriteQueues {
  private states = new Map<string, State>()
  private warn: (message: string) => void
  private failure: (error: unknown) => void
  constructor(warn: (message: string) => void = () => {}, failure?: (error: unknown) => void) {
    this.warn = warn
    this.failure = failure ?? (error => this.warn(`Engram queued capture failed: ${error instanceof Error ? error.message : String(error)}`))
  }
  run<T>(id: string, job: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(signal.reason)
    let state = this.states.get(id)
    if (!state) { state = { items: [], running: false, closed: false, idle: new Set() }; this.states.set(id, state) }
    const current = state
    return new Promise<T>((resolve, reject) => {
      const item: Item = { job, resolve: value => resolve(value as T), reject, unwatch: () => signal?.removeEventListener('abort', cancel) }
      const cancel = () => {
        const index = current.items.indexOf(item)
        if (index >= 0) { current.items.splice(index, 1); item.unwatch(); reject(signal?.reason) }
      }
      current.items.push(item)
      signal?.addEventListener('abort', cancel, { once: true })
      if (!current.running) { current.running = true; queueMicrotask(() => { void this.pump(current) }) }
    })
  }
  enqueue(id: string, job: () => Promise<unknown>): void {
    void this.run(id, job).catch(error => this.failure(error))
  }
  private async pump(state: State): Promise<void> {
    while (!state.closed && state.items.length) {
      const item = state.items.shift()!
      item.unwatch()
      try { item.resolve(await item.job()) } catch (error) { item.reject(error) }
    }
    state.running = false
    for (const notify of state.idle) notify()
    state.idle.clear()
  }
  async drain(id: string, timeoutMs = 5000): Promise<boolean> {
    const state = this.states.get(id)
    if (!state?.running && !state?.items.length) return true
    let notify: () => void = () => {}
    let timer: ReturnType<typeof setTimeout> | undefined
    const idle = new Promise<boolean>(resolve => { notify = () => resolve(true); state!.idle.add(notify) })
    const expired = new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), timeoutMs) })
    try {
      const drained = await Promise.race([idle, expired])
      if (!drained) this.warn('Engram write queue drain timed out; pending work remains queued')
      return drained
    } finally { clearTimeout(timer); state?.idle.delete(notify) }
  }
  dispose(id: string): void {
    const state = this.states.get(id)
    if (!state) return
    state.closed = true
    const pending = state.items.splice(0)
    for (const item of pending) { item.unwatch(); item.reject(new Error('Engram queued work was disposed before dispatch')) }
    if (pending.length) this.warn(`Engram write queue discarded ${pending.length} unstarted item(s)`)
    this.states.delete(id)
  }
  close(): void { for (const id of this.states.keys()) this.dispose(id) }
}
