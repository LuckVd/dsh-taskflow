/**
 * /api/taskflow/* HTTP 层（§6）：与框架无关的处理器 + SSE。
 *
 * 端点（同源，沿宿主浏览器信任围栏形态）：
 * - GET  /api/taskflow/state   全量带 revision 快照（+ health）
 * - GET  /api/taskflow/events  SSE：revision/调度变化推送（断线重连拉全量，NFR-04）
 * - POST /api/taskflow/action  幂等 action 提交（requestId 去重，≤64KiB）
 *
 * @module dsh-taskflow/host
 */

import type { IncomingHttpHeaders } from 'node:http'
import { MAX_ACTION_BYTES } from '../protocol/types.ts'
import type { TaskflowEngine } from './engine.ts'

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

/** 处理一次（非 SSE）请求；SSE 由 plugin 层用 {@link createSseStream} 绑定。 */
export async function handleTaskflowRequest(
  engine: TaskflowEngine,
  method: string,
  pathname: string,
  body: string | undefined,
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
