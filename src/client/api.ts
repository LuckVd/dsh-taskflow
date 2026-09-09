/**
 * 浏览器传输层：HTTP + SSE（NFR-04：SSE 推增量，重连/回前台拉全量）。
 *
 * @module dsh-taskflow/client
 */

import type { DispatchResult, EngineState } from '../protocol/types.ts'
import type { TaskflowAction } from '../protocol/actions.ts'

export interface TaskflowTransport {
  getState(): Promise<EngineState>
  dispatch(action: TaskflowAction): Promise<DispatchResult>
  /** 订阅 revision 变化；返回退订函数。 */
  subscribe(onChange: () => void): () => void
}

export function createHttpTransport(base = ''): TaskflowTransport {
  let source: EventSource | undefined
  return {
    async getState(): Promise<EngineState> {
      const response = await fetch(`${base}/api/taskflow/state`, { headers: { accept: 'application/json' } })
      if (!response.ok) throw new Error(`state ${response.status}`)
      return (await response.json()) as EngineState
    },
    async dispatch(action: TaskflowAction): Promise<DispatchResult> {
      const response = await fetch(`${base}/api/taskflow/action`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(action),
      })
      if (!response.ok) return { ok: false, code: 'storage', error: `HTTP ${response.status}` }
      return (await response.json()) as DispatchResult
    },
    subscribe(onChange: () => void): () => void {
      source?.close()
      source = new EventSource(`${base}/api/taskflow/events`)
      source.addEventListener('change', onChange)
      source.addEventListener('hello', onChange)
      return () => {
        source?.close()
        source = undefined
      }
    },
  }
}

/** demo/测试用：直接驱动引擎（无 HTTP）。 */
export function createLocalTransport(engine: {
  getState(): EngineState
  dispatch(action: unknown): Promise<DispatchResult>
  subscribe(listener: () => void): () => void
}): TaskflowTransport {
  return {
    getState: () => Promise.resolve(engine.getState()),
    dispatch: action => engine.dispatch(action),
    subscribe: onChange => engine.subscribe(onChange),
  }
}
