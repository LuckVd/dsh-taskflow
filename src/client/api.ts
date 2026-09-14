/**
 * 浏览器传输层：HTTP + SSE（NFR-04：SSE 推增量，重连/回前台拉全量）。
 *
 * @module dsh-taskflow/client
 */

import type { ArtifactPreview, DispatchResult, EngineState, GlobalSettings, ModelCatalog } from '../protocol/types.ts'
import type { TaskTemplate } from '../protocol/types.ts'
import type { TaskflowAction } from '../protocol/actions.ts'

export interface TaskflowTransport {
  getState(): Promise<EngineState>
  /** 最近一次成功快照（同步返回；从未加载过为 null）。看板秒开用：宿主办共享传输，
   *  通知栏在页面加载时已拉过一版，点开看板直接用它首屏渲染，再在后台对账。 */
  getCachedState(): EngineState | null
  dispatch(action: TaskflowAction): Promise<DispatchResult>
  /** 订阅 revision 变化；返回退订函数。 */
  subscribe(onChange: () => void): () => void
  /** 全局设置（模型两槽 + 调度并发；设置浮层）。 */
  getSettings(): Promise<GlobalSettings>
  /** 覆盖全局模型设置；服务端校验失败时抛错（调用方回滚 UI）。 */
  saveSettings(next: GlobalSettings): Promise<GlobalSettings>
  /** 宿主模型目录（下拉数据源）；部署未提供时抛错。 */
  getModels(): Promise<ModelCatalog>
  /** 交付物只读预览（§4.5b）：仅限该任务证据声明过的 artifacts 路径。 */
  getArtifactPreview(taskId: string, path: string): Promise<ArtifactPreview>
  /** 任务模板列表（FR-19）；部署未提供时抛错。 */
  getTemplates(): Promise<TaskTemplate[]>
  /** 覆盖模板全表（存为模板 / 删除）；服务端校验失败时抛错。 */
  saveTemplates(next: TaskTemplate[]): Promise<TaskTemplate[]>
}

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    // 服务端错误体（{ok:false,error}）优先展示：只回状态码会让浮层只剩「HTTP 502」这种无信息量提示
    let detail = ''
    try {
      const body = (await response.json()) as { error?: unknown }
      if (typeof body?.error === 'string' && body.error.length > 0) detail = `：${body.error}`
    } catch {
      // 非 JSON 错误体：退回状态码
    }
    throw new Error(`HTTP ${response.status}${detail}`)
  }
  return (await response.json()) as T
}

export function createHttpTransport(base = ''): TaskflowTransport {
  let source: EventSource | undefined
  /** 最近一次成功快照缓存（模块内共享传输时多个订阅者共用）。 */
  let cache: EngineState | null = null
  /** 单飞行：并发 getState 只发一个请求（首屏 refresh 与 SSE hello 触发的 refresh 合并）。 */
  let inflight: Promise<EngineState> | null = null
  return {
    async getState(): Promise<EngineState> {
      if (inflight === null) {
        inflight = (async () => {
          const response = await fetch(`${base}/api/taskflow/state`, { headers: { accept: 'application/json' } })
          if (!response.ok) throw new Error(`state ${response.status}`)
          const state = (await response.json()) as EngineState
          cache = state
          return state
        })().finally(() => {
          inflight = null
        })
      }
      return inflight
    },
    getCachedState(): EngineState | null {
      return cache
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
      // 非浏览器环境（jsdom 测试 / SSR 形态）无 EventSource：降级为轮询不可用的静默 no-op
      if (typeof EventSource === 'undefined') return () => undefined
      source?.close()
      source = new EventSource(`${base}/api/taskflow/events`)
      source.addEventListener('change', onChange)
      source.addEventListener('hello', onChange)
      return () => {
        source?.close()
        source = undefined
      }
    },
    async getSettings(): Promise<GlobalSettings> {
      return readJson(await fetch(`${base}/api/taskflow/settings`, { headers: { accept: 'application/json' } }))
    },
    async saveSettings(next: GlobalSettings): Promise<GlobalSettings> {
      return readJson(
        await fetch(`${base}/api/taskflow/settings`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(next),
        }),
      )
    },
    async getModels(): Promise<ModelCatalog> {
      return readJson(await fetch(`${base}/api/taskflow/models`, { headers: { accept: 'application/json' } }))
    },
    async getArtifactPreview(taskId: string, path: string): Promise<ArtifactPreview> {
      const query = new URLSearchParams({ taskId, path })
      const payload = await readJson<{ ok: boolean; preview: ArtifactPreview }>(
        await fetch(`${base}/api/taskflow/artifact/preview?${query.toString()}`, { headers: { accept: 'application/json' } }),
      )
      return payload.preview
    },
    async getTemplates(): Promise<TaskTemplate[]> {
      return readJson(await fetch(`${base}/api/taskflow/templates`, { headers: { accept: 'application/json' } }))
    },
    async saveTemplates(next: TaskTemplate[]): Promise<TaskTemplate[]> {
      return readJson(
        await fetch(`${base}/api/taskflow/templates`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(next),
        }),
      )
    },
  }
}
