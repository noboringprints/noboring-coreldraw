/**
 * Tiny request/response layer over a Worker: `call(type, payload)` returns a promise,
 * progress messages go to an optional callback. Keeps heavy pixel work off the main thread.
 */

export type RpcRequest = { id: number; type: string; payload: unknown }
export type RpcResponse = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string } | { id: number; progress: unknown }

export class RpcClient {
  private nextId = 1
  private pending = new Map<number, { resolve: (v: never) => void; reject: (e: Error) => void; onProgress?: (p: never) => void }>()

  constructor(private worker: Worker) {
    worker.onmessage = (e: MessageEvent<RpcResponse>) => {
      const m = e.data
      const p = this.pending.get(m.id)
      if (!p) return
      if ('progress' in m) return p.onProgress?.(m.progress as never)
      this.pending.delete(m.id)
      if (m.ok) p.resolve(m.result as never)
      else p.reject(new Error(m.error))
    }
    worker.onerror = (e) => {
      for (const p of this.pending.values()) p.reject(new Error(e.message || 'Worker failed'))
      this.pending.clear()
    }
  }

  call<R, P = unknown>(type: string, payload: unknown, opts: { transfer?: Transferable[]; onProgress?: (p: P) => void } = {}): Promise<R> {
    const id = this.nextId++
    return new Promise<R>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: never) => void, reject, onProgress: opts.onProgress as ((p: never) => void) | undefined })
      this.worker.postMessage({ id, type, payload } satisfies RpcRequest, opts.transfer ?? [])
    })
  }

  terminate() {
    this.worker.terminate()
    for (const p of this.pending.values()) p.reject(new Error('Cancelled'))
    this.pending.clear()
  }
}

/** Worker side: wires handlers to messages. A handler may report progress. */
export function serve(handlers: Record<string, (payload: never, progress: (p: unknown) => void) => Promise<{ result: unknown; transfer?: Transferable[] }>>) {
  self.onmessage = async (e: MessageEvent<RpcRequest>) => {
    const { id, type, payload } = e.data
    const post = (m: RpcResponse, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer)
    const h = handlers[type]
    if (!h) return post({ id, ok: false, error: `Unknown request ${type}` })
    try {
      const { result, transfer } = await h(payload as never, (progress) => post({ id, progress }))
      post({ id, ok: true, result }, transfer)
    } catch (err) {
      post({ id, ok: false, error: (err as Error)?.message ?? String(err) })
    }
  }
}
