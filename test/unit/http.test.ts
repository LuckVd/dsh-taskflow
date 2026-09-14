import { describe, expect, it } from 'vitest'
import { createSseStream, handleTaskflowRequest, isTrustedRequest } from '../../src/host/http.ts'
import { ArtifactPreviewError } from '../../src/host/artifacts.ts'
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

describe('全局设置与模型目录端点（§PLAN-MODEL / FR-13）', () => {
  function settingsEngine(): { engine: TaskflowEngine; saved: unknown[]; persisted: unknown[] } {
    const saved: unknown[] = []
    const persisted: unknown[] = []
    const engine = {
      getState: () => ({ ledger: { schemaVersion: 1, revision: 1, tasks: [] }, health: { corrupt: null, lastWriteFailed: false } }),
      dispatch: async () => ({ ok: true }),
      subscribe: () => () => undefined,
      getGlobalSettings: () => current,
      setGlobalSettings: (next: unknown) => {
        saved.push(next)
        current = next
      },
    } as unknown as TaskflowEngine
    let current: Record<string, unknown> = { decompose: null, execution: null }
    return { engine, saved, persisted }
  }

  it('GET settings 默认两槽 null', async () => {
    const { engine } = settingsEngine()
    const result = await handleTaskflowRequest(engine, 'GET', '/api/taskflow/settings', undefined)
    expect(result.status).toBe(200)
    expect(JSON.parse(result.body)).toEqual({ decompose: null, execution: null })
  })

  it('PUT settings 合法形状写入并回显；非法形状 400 且不写', async () => {
    const { engine, saved } = settingsEngine()
    const ok = await handleTaskflowRequest(
      engine,
      'PUT',
      '/api/taskflow/settings',
      JSON.stringify({ execution: { provider: 'deepseek', model: ' deepseek-chat ', reasoningEffort: 'high' } }),
    )
    expect(ok.status).toBe(200)
    expect(JSON.parse(ok.body).execution).toEqual({ provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' })
    expect(saved).toHaveLength(1)

    const bad = await handleTaskflowRequest(engine, 'PUT', '/api/taskflow/settings', JSON.stringify({ decompose: { provider: '' } }))
    expect(bad.status).toBe(400)
    const badJson = await handleTaskflowRequest(engine, 'PUT', '/api/taskflow/settings', 'not json')
    expect(badJson.status).toBe(400)
    const noBody = await handleTaskflowRequest(engine, 'PUT', '/api/taskflow/settings', undefined)
    expect(noBody.status).toBe(400)
    expect(saved).toHaveLength(1)
  })

  it('PUT settings 并发上限：合法写入回显；越界 400（FR-13）', async () => {
    const { engine, saved } = settingsEngine()
    const ok = await handleTaskflowRequest(
      engine,
      'PUT',
      '/api/taskflow/settings',
      JSON.stringify({ decompose: null, execution: null, maxConcurrentSubtasks: 3 }),
    )
    expect(ok.status).toBe(200)
    expect(JSON.parse(ok.body).maxConcurrentSubtasks).toBe(3)
    expect(saved).toHaveLength(1)

    const bad = await handleTaskflowRequest(
      engine,
      'PUT',
      '/api/taskflow/settings',
      JSON.stringify({ decompose: null, execution: null, maxConcurrentSubtasks: 0 }),
    )
    expect(bad.status).toBe(400)
    expect(saved).toHaveLength(1)
  })

  it('PUT settings 先落盘后生效：persist 失败 500 且不触碰引擎内存', async () => {
    const { engine, saved } = settingsEngine()
    const fail = await handleTaskflowRequest(engine, 'PUT', '/api/taskflow/settings', JSON.stringify({ maxConcurrentSubtasks: 2 }), {
      persistSettings: async () => {
        throw new Error('disk full')
      },
    })
    expect(fail.status).toBe(500)
    expect(saved).toHaveLength(0)
  })

  it('PUT settings 落盘口透传（持久化回调收到校验后的形状）', async () => {
    const { engine, persisted } = settingsEngine()
    const ok = await handleTaskflowRequest(engine, 'PUT', '/api/taskflow/settings', JSON.stringify({ maxConcurrentSubtasks: 4 }), {
      persistSettings: async next => {
        persisted.push(next)
      },
    })
    expect(ok.status).toBe(200)
    expect(JSON.parse(ok.body).maxConcurrentSubtasks).toBe(4)
    expect((persisted[0] as { maxConcurrentSubtasks?: number }).maxConcurrentSubtasks).toBe(4)
  })

  it('GET models：未注入提供方 501；注入则透传目录（目录加载失败 502）', async () => {
    const { engine } = settingsEngine()
    const missing = await handleTaskflowRequest(engine, 'GET', '/api/taskflow/models', undefined)
    expect(missing.status).toBe(501)

    const catalog = { default: { provider: 'p', model: 'm' }, groups: [] }
    const ok = await handleTaskflowRequest(engine, 'GET', '/api/taskflow/models', undefined, { models: async () => catalog })
    expect(ok.status).toBe(200)
    expect(JSON.parse(ok.body)).toEqual(catalog)

    const fail = await handleTaskflowRequest(engine, 'GET', '/api/taskflow/models', undefined, {
      models: async () => {
        throw new Error('registry gone')
      },
    })
    expect(fail.status).toBe(502)
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

describe('交付物只读预览端点（§4.5b/§7.4b）', () => {
  function previewEngine(preview: unknown): TaskflowEngine {
    return {
      readArtifactPreview: async (taskId: string, path: string) => {
        if (typeof preview === 'function') return (preview as (t: string, p: string) => unknown)(taskId, path)
        return preview
      },
    } as unknown as TaskflowEngine
  }

  it('happy path：返回 {ok:true, preview}', async () => {
    const engine = previewEngine({ path: '/root/r.md', size: 24_094, truncated: false, binary: false, content: '# 报告' })
    const query = new URLSearchParams({ taskId: 'tf_1', path: '/root/r.md' })
    const result = await handleTaskflowRequest(engine, 'GET', '/api/taskflow/artifact/preview', undefined, { query })
    expect(result.status).toBe(200)
    const body = JSON.parse(result.body) as { ok: boolean; preview: { path: string; content: string } }
    expect(body.ok).toBe(true)
    expect(body.preview.content).toBe('# 报告')
  })

  it('缺 taskId/path → 400；not-declared/not-found → 404；not-a-file → 400；io → 500', async () => {
    const missing = await handleTaskflowRequest(previewEngine(null), 'GET', '/api/taskflow/artifact/preview', undefined)
    expect(missing.status).toBe(400)

    const declared = (code: 'invalid-path' | 'not-declared' | 'not-found' | 'not-a-file' | 'io') =>
      previewEngine((_t: string, _p: string) => {
        throw new ArtifactPreviewError(code, 'boom')
      })
    const q = (path: string) => ({ query: new URLSearchParams({ taskId: 'tf_1', path }) })
    expect((await handleTaskflowRequest(declared('not-declared'), 'GET', '/api/taskflow/artifact/preview', undefined, q('/x'))).status).toBe(404)
    expect((await handleTaskflowRequest(declared('not-found'), 'GET', '/api/taskflow/artifact/preview', undefined, q('/x'))).status).toBe(404)
    expect((await handleTaskflowRequest(declared('not-a-file'), 'GET', '/api/taskflow/artifact/preview', undefined, q('/x'))).status).toBe(400)
    expect((await handleTaskflowRequest(declared('io'), 'GET', '/api/taskflow/artifact/preview', undefined, q('/x'))).status).toBe(500)

    const generic = previewEngine(() => {
      throw new Error('nope')
    })
    expect((await handleTaskflowRequest(generic, 'GET', '/api/taskflow/artifact/preview', undefined, q('/x'))).status).toBe(500)
  })
})
