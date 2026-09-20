/**
 * /api/taskflow/* HTTP 层（§6）：与框架无关的处理器 + SSE。
 *
 * 端点（同源，沿宿主浏览器信任围栏形态）：
 * - GET  /api/taskflow/state     全量带 revision 快照（+ health）
 * - GET  /api/taskflow/events    SSE：revision/调度变化推送（断线重连拉全量，NFR-04）
 * - POST /api/taskflow/action    幂等 action 提交（requestId 去重，≤64KiB）
 * - GET  /api/taskflow/settings  全局设置（模型两槽 + 调度并发，§PLAN-MODEL / FR-13）
 * - PUT  /api/taskflow/settings  覆盖全局设置（fail-closed 形状校验；先落盘后生效）
 * - GET  /api/taskflow/models    宿主模型目录投影（下拉数据源；未注入提供方 → 501）
 * - GET  /api/taskflow/templates 任务模板列表（FR-19；未注入存储 → 501）
 * - PUT  /api/taskflow/templates 覆盖模板全表（fail-closed 校验；先落盘后生效）
 * - GET  /api/taskflow/artifact/preview?taskId=&path=  交付物只读预览（仅限证据声明过的路径，§7.4b）
 *
 * @module dsh-taskflow/host
 */

import type { IncomingHttpHeaders } from 'node:http'
import { readdirSync } from 'node:fs'
import path from 'node:path'
import { MAX_ACTION_BYTES } from '../protocol/types.ts'
import type { GlobalSettings, ModelCatalog } from '../protocol/types.ts'
import { isArtifactPreviewError } from './artifacts.ts'
import type { TaskflowEngine } from './engine.ts'
import { SettingsError, validateGlobalSettings } from './settings.ts'
import { TemplateError, validateTemplates } from './templates.ts'
import type { TaskTemplate } from './templates.ts'

export interface HttpResult {
  status: number
  headers: Record<string, string>
  body: string
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }

export class HttpBadRequest extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HttpBadRequest'
  }
}

/** 浏览器信任围栏（沿 dsh /api 形态）：Host 必须是 loopback/受信主机；Origin/sec-fetch-site 若存在必须同源。 */
export function isTrustedRequest(
  headers: IncomingHttpHeaders,
  opts: { host?: string; port?: number; trustedHosts?: readonly string[] } = {},
): boolean {
  const host = typeof headers.host === 'string' ? headers.host.toLowerCase() : undefined
  if (host === undefined) return false
  const hostname = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '')
  const loopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]'
  const trusted = (opts.trustedHosts ?? []).some(entry => entry.toLowerCase() === host)
  if (!loopback && !trusted) return false

  const origin = typeof headers.origin === 'string' ? headers.origin : undefined
  if (origin !== undefined) {
    try {
      const originUrl = new URL(origin)
      const originHost = originUrl.port
        ? `${originUrl.hostname}:${originUrl.port}`
        : originUrl.hostname
      if (originHost.toLowerCase() !== host) return false
    } catch {
      return false
    }
  }
  const fetchSite = typeof headers['sec-fetch-site'] === 'string' ? headers['sec-fetch-site'] : undefined
  if (fetchSite !== undefined && fetchSite !== 'same-origin' && fetchSite !== 'none') return false
  return true
}

/** 处理一次（非 SSE）请求；SSE 由 plugin 层用 {@link createSseStream} 绑定。
 *  `models`：宿主模型目录投影的提供方（dsh 适配器注入 ctx.llm 投影）。
 *  未提供时 GET models 返回 501（客户端展示「目录不可用」，两槽仍可保存）。
 *  `persistSettings`：设置落盘口（GlobalSettingsStore.update）；未提供时 PUT settings
 *  仅改内存（测试桩/无盘部署）——生产入口必须提供，否则设置重启即失。
 *  `query`：URL 查询参数（artifact/preview 用 taskId/path 定位）。 */
export async function handleTaskflowRequest(
  engine: TaskflowEngine,
  method: string,
  pathname: string,
  body: string | undefined,
  opts: {
    models?: () => Promise<ModelCatalog>
    presets?: () => Array<{ id: string; name: string }>
    persistSettings?: (settings: GlobalSettings) => Promise<unknown>
    templates?: { get: () => TaskTemplate[]; update: (raw: unknown) => Promise<TaskTemplate[]> }
    /** webhook 建卡令牌（FR-17）；提供时 POST /hook 校验 ?token= 或 x-taskflow-token。 */
    webhookToken?: string
    query?: URLSearchParams
    headers?: IncomingHttpHeaders
  } = {},
): Promise<HttpResult> {
  if (method === 'GET' && pathname === '/api/taskflow/state') {
    const state = engine.getState()
    return { status: 200, headers: JSON_HEADERS, body: JSON.stringify(state) }
  }
  if (method === 'POST' && pathname === '/api/taskflow/action') {
    if (body === undefined) return jsonError(400, 'request body required (JSON).')
    const bytes = Buffer.byteLength(body, 'utf8')
    if (bytes > MAX_ACTION_BYTES) return jsonError(413, `action exceeds ${MAX_ACTION_BYTES} bytes.`)
    let parsed: unknown
    try {
      parsed = JSON.parse(body)
    } catch {
      return jsonError(400, 'request body must be valid JSON.')
    }
    const result = await engine.dispatch(parsed)
    return { status: 200, headers: JSON_HEADERS, body: JSON.stringify(result) }
  }
  if (method === 'GET' && pathname === '/api/taskflow/settings') {
    const settings: GlobalSettings = engine.getGlobalSettings()
    return { status: 200, headers: JSON_HEADERS, body: JSON.stringify(settings) }
  }
  if (method === 'PUT' && pathname === '/api/taskflow/settings') {
    if (body === undefined) return jsonError(400, 'request body required (JSON).')
    const bytes = Buffer.byteLength(body, 'utf8')
    if (bytes > MAX_ACTION_BYTES) return jsonError(413, `settings exceed ${MAX_ACTION_BYTES} bytes.`)
    let parsed: unknown
    try {
      parsed = JSON.parse(body)
    } catch {
      return jsonError(400, 'request body must be valid JSON.')
    }
    let settings: GlobalSettings
    try {
      settings = validateGlobalSettings(parsed)
    } catch (error) {
      return jsonError(400, error instanceof SettingsError ? error.message : 'invalid settings shape.')
    }
    // 先持久化后生效（fail-closed）：落盘失败不改动引擎内存，重启后仍是旧值
    if (opts.persistSettings !== undefined) {
      try {
        await opts.persistSettings(settings)
      } catch (error) {
        return jsonError(500, `settings persist failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    engine.setGlobalSettings(settings)
    return { status: 200, headers: JSON_HEADERS, body: JSON.stringify(engine.getGlobalSettings()) }
  }
  if (method === 'GET' && pathname === '/api/taskflow/models') {
    if (opts.models === undefined) return jsonError(501, 'model catalog is unavailable in this deployment.')
    try {
      const catalog = await opts.models()
      return { status: 200, headers: JSON_HEADERS, body: JSON.stringify(catalog) }
    } catch (error) {
      return jsonError(502, `model catalog load failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (method === 'GET' && pathname === '/api/taskflow/templates') {
    if (opts.templates === undefined) return jsonError(501, 'template store is unavailable in this deployment.')
    return { status: 200, headers: JSON_HEADERS, body: JSON.stringify(opts.templates.get()) }
  }
  if (method === 'PUT' && pathname === '/api/taskflow/templates') {
    if (opts.templates === undefined) return jsonError(501, 'template store is unavailable in this deployment.')
    if (body === undefined) return jsonError(400, 'request body required (JSON).')
    const bytes = Buffer.byteLength(body, 'utf8')
    if (bytes > MAX_ACTION_BYTES) return jsonError(413, `templates exceed ${MAX_ACTION_BYTES} bytes.`)
    let parsed: unknown
    try {
      parsed = JSON.parse(body)
    } catch {
      return jsonError(400, 'request body must be valid JSON.')
    }
    try {
      validateTemplates(parsed)
    } catch (error) {
      return jsonError(400, error instanceof TemplateError ? error.message : 'invalid templates shape.')
    }
    // 先落盘后生效（fail-closed）：落盘失败不返回新表
    try {
      const saved = await opts.templates.update(parsed)
      return { status: 200, headers: JSON_HEADERS, body: JSON.stringify(saved) }
    } catch (error) {
      return jsonError(500, `templates persist failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (method === 'POST' && pathname === '/api/taskflow/hook') {
    // FR-17 webhook 建卡：令牌门（配置了 webhookToken 才强制）→ 复用 createTask action 全套守卫
    if (opts.webhookToken !== undefined) {
      const presented = opts.query?.get('token') ?? (typeof opts.headers?.['x-taskflow-token'] === 'string' ? opts.headers['x-taskflow-token'] : undefined)
      if (presented !== opts.webhookToken) return jsonError(403, 'webhook token mismatch.')
    }
    if (body === undefined) return jsonError(400, 'request body required (JSON).')
    let payload: Record<string, unknown>
    try {
      payload = JSON.parse(body) as Record<string, unknown>
    } catch {
      return jsonError(400, 'request body must be valid JSON.')
    }
    const action: Record<string, unknown> = {
      type: 'createTask',
      requestId: `hook_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      title: payload.title,
      description: payload.description ?? '',
    }
    for (const key of ['objective', 'acceptance', 'pins', 'autoStart', 'maxRounds'] as const) {
      if (payload[key] !== undefined) action[key] = payload[key]
    }
    const result = await engine.dispatch(action)
    return { status: 200, headers: JSON_HEADERS, body: JSON.stringify(result) }
  }
  if (method === 'GET' && pathname === '/api/taskflow/dirs') {
    return listDirectories(opts.query?.get('path') ?? '/')
  }
  if (method === 'GET' && pathname === '/api/taskflow/presets') {
    const presets = opts.presets?.() ?? []
    return { status: 200, headers: JSON_HEADERS, body: JSON.stringify({ presets }) }
  }
  if (method === 'GET' && pathname === '/api/taskflow/artifact/preview') {
    const taskId = opts.query?.get('taskId') ?? ''
    const path = opts.query?.get('path') ?? ''
    if (taskId.length === 0 || path.length === 0) {
      return jsonError(400, 'taskId and path query parameters are required.')
    }
    try {
      const preview = await engine.readArtifactPreview(taskId, path)
      return { status: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok: true, preview }) }
    } catch (error) {
      if (isArtifactPreviewError(error)) {
        const status = error.code === 'invalid-path' || error.code === 'not-a-file'
          ? 400
          : error.code === 'io' ? 500 : 404
        return jsonError(status, error.message)
      }
      return jsonError(500, `artifact preview failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return jsonError(404, `no taskflow route for ${method} ${pathname}`)
}

/**
 * 绑定一条 SSE 连接：推送 revision 变化与心跳。
 * 返回 [write(chunk), dispose()]；HTTP 语义（headers/flush）由绑定层负责。
 */
export function createSseStream(
  engine: TaskflowEngine,
  write: (chunk: string) => void,
): { dispose: () => void } {
  write(`retry: 3000\n\n`)
  write(`event: hello\ndata: ${JSON.stringify({ revision: engine.getState().ledger.revision })}\n\n`)
  const unsubscribe = engine.subscribe(ledger => {
    write(`event: change\ndata: ${JSON.stringify({ revision: ledger.revision })}\n\n`)
  })
  const heartbeat = setInterval(() => {
    write(`: heartbeat ${Date.now()}\n\n`)
  }, 25_000)
  return {
    dispose: () => {
      clearInterval(heartbeat)
      unsubscribe()
    },
  }
}

function jsonError(status: number, message: string): HttpResult {
  return { status, headers: JSON_HEADERS, body: JSON.stringify({ ok: false, error: message }) }
}

/**
 * 工作目录浏览（FR-21）：列出某绝对路径下的子目录（跳过隐藏目录，上限 200）。
 * 只读、只回目录名与拼接路径——不做任何写操作，供创建表单的目录选择器使用。
 */
function listDirectories(rawPath: string | undefined): HttpResult {
  const requested = rawPath ?? '/'
  if (!requested.startsWith('/')) return jsonError(400, 'path must be an absolute path.')
  const target = path.resolve(requested)
  let entries: string[]
  try {
    entries = readdirSync(target, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .map(e => e.name)
      .sort((a, b) => a.localeCompare(b))
      .slice(0, 200)
  } catch (error) {
    return jsonError(400, `cannot list ${target}: ${error instanceof Error ? error.message : String(error)}`)
  }
  const parent = path.dirname(target)
  return {
    status: 200,
    headers: JSON_HEADERS,
    body: JSON.stringify({
      path: target,
      parent: parent === target ? null : parent,
      dirs: entries.map(name => ({ name, path: path.join(target, name) })),
    }),
  }
}

