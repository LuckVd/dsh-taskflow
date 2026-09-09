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
import { createSseStream, handleTaskflowRequest, isTrustedRequest } from '../http.ts'
import { DshSessionAdapter } from './adapter.ts'

export const name = 'dsh-taskflow'
export const inject = ['agents', 'tools', 'webServer', 'sessionPersistence', 'permissionPresets', 'agentPresets', 'agentDefaultModel']

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
    defaultModelSelection: () => {
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
    },
  })
  const engine = new TaskflowEngine(new LedgerStore(path.join(dataDir, 'ledger.json')), adapter, engineConfig)

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
      const result = await handleTaskflowRequest(engine, req.method ?? 'GET', url.pathname, body)
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
  if (req.method !== 'POST') return Promise.resolve(undefined)
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

export { TaskflowEngine, LedgerStore }
