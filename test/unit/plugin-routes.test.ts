/**
 * dsh 插件层路由注册契约（§7.4b 回归，真机 2026-09-11 事故）：
 * handleTaskflowRequest 的每一条路由都必须在插件层 register——漏注册时请求
 * 根本到不了 apiHandler，由 dsh 路由器直接 404；单测直调 handler 与 demo
 * catch-all 都测不出这一层。artifact/preview 曾因此整条预览链路真机全挂。
 */
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply } from '../../src/host/dsh/plugin.ts'
import { cleanup, tempDir } from '../helpers.ts'

/** 与 plugin.ts 的 apiHandler/sseHandler 信任判断解耦的最小宿主面。 */
function fakeCtx(): { ctx: Context; registered: Array<{ kind: string; path: string }> } {
  const registered: Array<{ kind: string; path: string }> = []
  const ctx = {
    effect(fn: () => void): void {
      fn()
    },
    logger: { warn(): void {}, info(): void {}, error(): void {} },
    webServer: {
      register(route: { kind: string; path: string; handler: unknown }): () => void {
        registered.push({ kind: route.kind, path: route.path })
        return () => undefined
      },
    },
    agents: {},
    sessionPersistence: {},
  }
  return { ctx: ctx as unknown as Context, registered }
}

describe('插件路由注册契约', () => {
  it('http.ts 的每条路由都必须注册（漏注册 = dsh 路由器直接 404，handler 收不到）', async () => {
    const dir = await tempDir('taskflow-plugin-routes-')
    try {
      const { ctx, registered } = fakeCtx()
      apply(ctx, { dataDir: dir })
      const paths = registered.map(route => route.path)
      for (const path of [
        '/api/taskflow/state',
        '/api/taskflow/action',
        '/api/taskflow/events',
        '/api/taskflow/settings',
        '/api/taskflow/models',
        '/api/taskflow/artifact/preview',
        '/api/taskflow/dirs',
      ]) {
        expect(paths, `route ${path} must be registered in the dsh plugin`).toContain(path)
      }
      // 全部走 exact 匹配：路径带查询/后缀的请求交给 dsh 路由器精确分发
      expect(registered.every(route => route.kind === 'exact')).toBe(true)
    } finally {
      await cleanup(dir)
    }
  })
})
