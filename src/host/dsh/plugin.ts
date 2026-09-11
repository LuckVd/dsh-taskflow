/**
 * dsh-taskflow 宿主插件入口（cordis function plugin）。
 *
 * 组装：$DSH_HOME/taskflow/ledger.json → LedgerStore → TaskflowEngine +
 * DshSessionAdapter；注册 /api/taskflow/* 三条路由（state/action/SSE）。
 *
 * 安装：`dsh plugin --profile <name> add dsh-taskflow`（bundle patch 见 cordis.patch.yml）。
 *
 * @module dsh-taskflow
 */

import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'

/** npm 0.0.1-rc.x 暴露 httpServer，宿主 0.1.0-rc.x+ 改名 webServer；运行时取存在的那个。 */
function routeTable(ctx: Context): { register(route: WebRoute): () => void } {
  const candidate = ctx as unknown as {
    webServer?: { register(route: WebRoute): () => void }
    httpServer?: { register(route: WebRoute): () => void }
  }
  const table = candidate.webServer ?? candidate.httpServer
  if (table === undefined) throw new Error('taskflow: host has no webServer/httpServer service')
  return table
}
import { dshHomePath } from './compat.ts'
import { DEFAULT_ENGINE_CONFIG, TaskflowEngine } from '../engine.ts'
import type { EngineConfig } from '../engine.ts'
import { LedgerStore } from '../ledger.ts'
import { ModelSettingsStore } from '../settings.ts'
import { createSseStream, handleTaskflowRequest, isTrustedRequest } from '../http.ts'
import type { ModelCatalog, ModelCatalogGroup } from '../../protocol/types.ts'
import { DshSessionAdapter } from './adapter.ts'

export const name = 'dsh-taskflow'
// 注意：cordis 对未 inject 的服务「取属性即抛错」（cannot get property "x" without inject），
// 结构性访问 ctx.llm 前必须在此声明（模型目录投影依赖它）。
export const inject = ['agents', 'tools', 'webServer', 'sessionPersistence', 'permissionPresets', 'agentPresets', 'agentDefaultModel', 'llm']

export interface TaskflowPluginConfig {
  /** 数据目录；默认 $DSH_HOME/taskflow（NFR-07：与 dsh-task-board 完全分离）。 */
  dataDir?: string
  /** 并发子任务会话上限（M1 默认 1 = 串行）。 */
  maxConcurrentSubtasks?: number
  /** 会话默认权限（权限确认门基线，§7.1）。 */
  sessionDefaultPermission?: string
  /** 宿主默认工作区（pins.workspace 为空时的落点）。 */
  defaultWorkspace?: string
}

export function apply(ctx: Context, config: TaskflowPluginConfig = {}): void {
  const dataDir = config.dataDir ?? dshHomePath('taskflow')
  const engineConfig: EngineConfig = {
    ...DEFAULT_ENGINE_CONFIG,
    ...(config.maxConcurrentSubtasks !== undefined ? { maxConcurrentSubtasks: config.maxConcurrentSubtasks } : {}),
    ...(config.sessionDefaultPermission !== undefined
      ? { sessionDefaultPermission: config.sessionDefaultPermission }
      : {}),
  }
  const adapter = new DshSessionAdapter({
    ctx,
    defaultWorkspace: config.defaultWorkspace ?? process.cwd(),
    defaultPermission: engineConfig.sessionDefaultPermission,
    defaultModelSelection: () => readDefaultModelSelection(ctx),
  })
  const engine = new TaskflowEngine(new LedgerStore(path.join(dataDir, 'ledger.json')), adapter, engineConfig)
  const settings = new ModelSettingsStore(path.join(dataDir, 'settings.json'))

  ctx.effect(() => {
    // 设置加载失败不阻塞启动：回退默认（两槽 = 跟随宿主），lastLoadError 留排查口
    void settings
      .load()
      .then(() => engine.setModelSettings(settings.get()))
      .catch(error => {
        ctx.logger.warn(`taskflow: settings load failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    return () => undefined
  }, 'taskflow.settings()')

  ctx.effect(() => {
    void engine.boot().catch(error => {
      ctx.logger.warn(`taskflow: boot failed: ${error instanceof Error ? error.message : String(error)}`)
    })
    return () => {
      void engine.dispose()
    }
  }, 'taskflow.engine()')

  ctx.effect(() => {
    const table = routeTable(ctx)
    const disposeRoutes = [
      table.register({ kind: 'exact', path: '/api/taskflow/state', handler: apiHandler }),
      table.register({ kind: 'exact', path: '/api/taskflow/action', handler: apiHandler }),
      table.register({ kind: 'exact', path: '/api/taskflow/events', handler: sseHandler }),
      table.register({ kind: 'exact', path: '/api/taskflow/settings', handler: apiHandler }),
      table.register({ kind: 'exact', path: '/api/taskflow/models', handler: apiHandler }),
    ]
    return () => {
      for (const dispose of disposeRoutes) dispose()
    }
  }, 'taskflow.routes()')

  async function apiHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (!isTrustedRequest(req.headers)) {
        res.writeHead(403, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'forbidden: request is not browser-trusted.' }))
        return
      }
      const url = new URL(req.url ?? '/', 'http://localhost')
      const body = await readBody(req)
      const result = await handleTaskflowRequest(engine, req.method ?? 'GET', url.pathname, body, {
        models: buildModelCatalogFrom(ctx),
        query: url.searchParams,
      })
      res.writeHead(result.status, result.headers)
      res.end(result.body)
    } catch (error) {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'internal error' }))
      void error
    }
  }

  function sseHandler(req: IncomingMessage, res: ServerResponse): void {
    if (!isTrustedRequest(req.headers)) {
      res.writeHead(403, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'forbidden: request is not browser-trusted.' }))
      return
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    })
    const stream = createSseStream(engine, chunk => res.write(chunk))
    req.on('close', () => stream.dispose())
  }
}

function readBody(req: IncomingMessage, limitBytes = 128 * 1024): Promise<string | undefined> {
  if (req.method !== 'POST' && req.method !== 'PUT') return Promise.resolve(undefined)
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.byteLength
      if (size > limitBytes) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** 宿主默认模型选择（agentDefaultModel.currentSelection() 的结构化读取；缺形/不可用 → undefined）。 */
function readDefaultModelSelection(ctx: Context): { provider: string; model: string; reasoningEffort?: string } | undefined {
  try {
    const service = (ctx as unknown as Record<string, unknown>)['agentDefaultModel'] as
      | { currentSelection?: () => unknown }
      | undefined
    const selection = service?.currentSelection?.() as { provider?: unknown; model?: unknown } | undefined
    if (selection === undefined || typeof selection.provider !== 'string' || typeof selection.model !== 'string') return undefined
    return {
      provider: selection.provider,
      model: selection.model,
      ...(typeof (selection as { reasoningEffort?: unknown }).reasoningEffort === 'string'
        ? { reasoningEffort: (selection as { reasoningEffort: string }).reasoningEffort }
        : {}),
    }
  } catch {
    return undefined
  }
}

/**
 * 宿主模型目录投影（GET /api/taskflow/models 数据源）：结构性访问 ctx.llm 的
 * listProviders / listModels / resolveModelInfo（dsh-api-session-controller
 * buildModelCatalog 的同款面，零新增依赖）。
 *
 * 降级策略：目录是「锦上添花」的数据源，任何一层失败都不该让浮层彻底不可用——
 * llm 服务缺失/取用抛错 → 空目录（客户端只剩「跟随宿主默认」项，仍可保存）；
 * 单 provider 失败 → 跳过该 provider。整体仍抛错时由 HTTP 层转 502（带原因）。
 */
function buildModelCatalogFrom(ctx: Context): () => Promise<ModelCatalog> {
  return async (): Promise<ModelCatalog> => {
    const fallback = (): ModelCatalog => ({ default: readDefaultModelSelection(ctx) ?? null, groups: [] })
    const llm = (ctx as unknown as Record<string, unknown>)['llm'] as
      | {
          listProviders?: () => Array<{ id: string; name?: string }>
          listModels?: (id: string) => Promise<Array<{ id: string; name?: string; description?: string }>>
          resolveModelInfo?: (providerId: string, modelId: string) => Promise<{
            reasoning?: { efforts?: Array<{ id: string; name?: string }>; defaultEffort?: string }
          } | undefined>
        }
      | undefined
    if (llm?.listProviders === undefined || llm?.listModels === undefined) return fallback()
    const groups: ModelCatalogGroup[] = []
    let providers: Array<{ id: string; name?: string }>
    try {
      providers = llm.listProviders()
    } catch {
      return fallback()
    }
    for (const provider of providers) {
      try {
        const models = await llm.listModels(provider.id)
        const entries = await Promise.all(
          models.map(async model => {
            let reasoning: ModelCatalogGroup['models'][number]['reasoning']
            try {
              const info = await llm.resolveModelInfo?.(provider.id, model.id)
              const efforts = info?.reasoning?.efforts
              if (efforts !== undefined && efforts.length > 0) {
                reasoning = {
                  efforts: efforts.map(effort => ({ id: effort.id, name: effort.name ?? effort.id })),
                  ...(info?.reasoning?.defaultEffort !== undefined ? { defaultEffort: info.reasoning.defaultEffort } : {}),
                }
              }
            } catch {
              // resolve 失败 = 该模型无可选力度，忽略
            }
            return {
              id: model.id,
              name: model.name ?? model.id,
              ...(reasoning !== undefined ? { reasoning } : {}),
            }
          }),
        )
        groups.push({ id: provider.id, name: provider.name ?? provider.id, models: entries })
      } catch {
        // 该 provider 目录加载失败：跳过（不拖垮整个目录）
      }
    }
    return { default: readDefaultModelSelection(ctx) ?? null, groups }
  }
}

export { TaskflowEngine, LedgerStore }
/** 供测试直接覆盖目录投影的降级路径（生产入口是 GET /api/taskflow/models）。 */
export { buildModelCatalogFrom }
