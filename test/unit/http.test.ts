import { describe, expect, it } from 'vitest'
import { createSseStream, handleTaskflowRequest, isTrustedRequest } from '../../src/host/http.ts'
import type { TaskflowEngine } from '../../src/host/engine.ts'

function fakeEngine(): { engine: TaskflowEngine; dispatchCalls: unknown[] } {
  const dispatchCalls: unknown[] = []
  return {
    dispatchCalls,
    engine: {
      getState: () => ({ ledger: { schemaVersion: 1, revision: 7, tasks: [] }, health: { corrupt: null, lastWriteFailed: false } }),
      dispatch: async (action: unknown) => {
        dispatchCalls.push(action)
        return { ok: true, revision: 8 }
      },
      subscribe: (_listener: unknown) => () => {},
    } as unknown as TaskflowEngine,
  }
}

describe('浏览器信任围栏（§6/NFR-06）', () => {
  it('loopback Host 通过；外域 Host 拒绝', () => {
    expect(isTrustedRequest({ host: '127.0.0.1:3080' })).toBe(true)
    expect(isTrustedRequest({ host: 'localhost:3080' })).toBe(true)
    expect(isTrustedRequest({ host: 'evil.example.com' })).toBe(false)
    expect(isTrustedRequest({})).toBe(false)
  })

  it('trustedHosts 声明的局域网主机通过', () => {
    expect(isTrustedRequest({ host: '192.168.1.5:3080' }, { trustedHosts: ['192.168.1.5:3080'] })).toBe(true)
    expect(isTrustedRequest({ host: '192.168.1.5:3080' }, { trustedHosts: [] })).toBe(false)
  })

  it('跨站 Origin / sec-fetch-site 拒绝', () => {
    expect(isTrustedRequest({ host: 'localhost:3080', origin: 'http://evil.example.com' })).toBe(false)
    expect(isTrustedRequest({ host: 'localhost:3080', origin: 'http://localhost:3080' })).toBe(true)
    expect(isTrustedRequest({ host: 'localhost:3080', 'sec-fetch-site': 'cross-site' })).toBe(false)
    expect(isTrustedRequest({ host: 'localhost:3080', 'sec-fetch-site': 'same-origin' })).toBe(true)
  })
})

describe('/api/taskflow 端点（§6）', () => {
  it('GET state 返回全量带 revision 快照', async () => {
    const { engine } = fakeEngine()
    const result = await handleTaskflowRequest(engine, 'GET', '/api/taskflow/state', undefined)
    expect(result.status).toBe(200)
    const body = JSON.parse(result.body) as { ledger: { revision: number }; health: { corrupt: unknown } }
    expect(body.ledger.revision).toBe(7)
    expect(body.health.corrupt).toBeNull()
  })

  it('POST action 透传引擎并返回结果；非 JSON 拒绝', async () => {
    const { engine, dispatchCalls } = fakeEngine()
    const ok = await handleTaskflowRequest(engine, 'POST', '/api/taskflow/action', '{"type":"createTask","requestId":"r1","title":"t","description":"d"}')
    expect(ok.status).toBe(200)
    expect(JSON.parse(ok.body)).toEqual({ ok: true, revision: 8 })
    expect(dispatchCalls).toHaveLength(1)

    const bad = await handleTaskflowRequest(engine, 'POST', '/api/taskflow/action', 'not json')
    expect(bad.status).toBe(400)
  })

  it('超过 64KiB 的 action 拒绝（§6）', async () => {
    const { engine } = fakeEngine()
    const huge = JSON.stringify({ type: 'createTask', requestId: 'r', title: 't', description: 'x'.repeat(70 * 1024) })
    const result = await handleTaskflowRequest(engine, 'POST', '/api/taskflow/action', huge)
    expect(result.status).toBe(413)
  })

  it('未知路由 404', async () => {
    const { engine } = fakeEngine()
    const result = await handleTaskflowRequest(engine, 'GET', '/api/taskflow/nope', undefined)
    expect(result.status).toBe(404)
  })
})

describe('SSE 流（NFR-04）', () => {
  it('hello 帧含当前 revision；change 帧在变更时推送；dispose 停止', async () => {
    const listeners: Array<(ledger: unknown) => void> = []
    const engine = {
      getState: () => ({ ledger: { revision: 3 } }),
      subscribe: (listener: (ledger: unknown) => void) => {
        listeners.push(listener)
        return () => {
          const index = listeners.indexOf(listener)
          if (index >= 0) listeners.splice(index, 1)
        }
      },
    } as unknown as TaskflowEngine
    const chunks: string[] = []
    const stream = createSseStream(engine, chunk => chunks.push(chunk))
    expect(chunks[0]).toContain('retry:')
    expect(chunks[1]).toContain('"revision":3')
    expect(chunks[1]).toContain('event: hello')
    const listener = listeners[0]!
    listener({ revision: 4 })
    expect(chunks[2]).toContain('event: change')
    expect(chunks[2]).toContain('"revision":4')
    stream.dispose()
    // dispose 后订阅已注销（真实 store 不再回调；此处以注册表清空为证）
    expect(listeners).toHaveLength(0)
    expect(chunks).toHaveLength(3)
  })
})
