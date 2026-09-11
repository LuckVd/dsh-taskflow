/**
 * 宿主模型目录投影（§PLAN-MODEL）：注入契约 + 降级路径。
 *
 * 背景（真机踩坑）：cordis 对**未在 inject 声明的服务**取属性即抛
 * `cannot get property "llm" without inject` —— 曾导致 /api/taskflow/models 502。
 * 本文件锁死两件事：①插件必须声明 llm；②目录投影的每一层降级都不该让浮层不可用。
 */
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { buildModelCatalogFrom, inject } from '../../src/host/dsh/plugin.ts'

function fakeCtx(services: Record<string, unknown>): Context {
  return services as unknown as Context
}

const defaultSelection = { provider: 'deepseek', model: 'deepseek-chat' }

describe('插件注入契约', () => {
  it('inject 必须声明 llm（否则取 ctx.llm 即抛错 → 目录端点 502）', () => {
    expect(inject).toContain('llm')
    expect(inject).toContain('agentDefaultModel')
    expect(inject).toContain('webServer')
  })
})

describe('buildModelCatalogFrom：目录投影与降级', () => {
  it('完整 llm 面 → 分组 + 推理力度映射', async () => {
    const ctx = fakeCtx({
      agentDefaultModel: { currentSelection: () => defaultSelection },
      llm: {
        listProviders: () => [
          { id: 'deepseek', name: 'DeepSeek' },
          { id: 'ollama', name: 'Ollama（本机）' },
        ],
        listModels: async (providerId: string) =>
          providerId === 'deepseek'
            ? [{ id: 'deepseek-chat', name: 'deepseek-chat' }, { id: 'deepseek-reasoner', name: 'deepseek-reasoner' }]
            : [{ id: 'qwen3:8b' }],
        resolveModelInfo: async (_providerId: string, modelId: string) =>
          modelId === 'deepseek-reasoner'
            ? { reasoning: { efforts: [{ id: 'low' }, { id: 'high', name: '高' }], defaultEffort: 'high' } }
            : {},
      },
    })
    const catalog = await buildModelCatalogFrom(ctx)()
    expect(catalog.default).toEqual(defaultSelection)
    expect(catalog.groups.map(group => group.id)).toEqual(['deepseek', 'ollama'])
    expect(catalog.groups[1]?.name).toBe('Ollama（本机）')
    // name 缺省回退 id；efforts 缺 name 回退 id
    expect(catalog.groups[1]?.models[0]).toEqual({ id: 'qwen3:8b', name: 'qwen3:8b' })
    expect(catalog.groups[0]?.models[1]?.reasoning).toEqual({
      efforts: [{ id: 'low', name: 'low' }, { id: 'high', name: '高' }],
      defaultEffort: 'high',
    })
    expect(catalog.groups[0]?.models[0]?.reasoning).toBeUndefined()
  })

  it('llm 服务缺失 → 空目录（不抛；保留宿主默认供「跟随宿主默认」展示）', async () => {
    const ctx = fakeCtx({ agentDefaultModel: { currentSelection: () => defaultSelection } })
    const catalog = await buildModelCatalogFrom(ctx)()
    expect(catalog).toEqual({ default: defaultSelection, groups: [] })
  })

  it('listProviders 抛错 → 空目录（不让端点 502）', async () => {
    const ctx = fakeCtx({
      agentDefaultModel: { currentSelection: () => defaultSelection },
      llm: {
        listProviders: () => {
          throw new Error('registry unavailable')
        },
        listModels: async () => [],
      },
    })
    await expect(buildModelCatalogFrom(ctx)()).resolves.toEqual({ default: defaultSelection, groups: [] })
  })

  it('单 provider 目录失败 → 只跳过该 provider', async () => {
    const ctx = fakeCtx({
      agentDefaultModel: { currentSelection: () => defaultSelection },
      llm: {
        listProviders: () => [{ id: 'broken' }, { id: 'ok' }],
        listModels: async (providerId: string) => {
          if (providerId === 'broken') throw new Error('catalog lookup failed')
          return [{ id: 'm', name: 'M' }]
        },
      },
    })
    const catalog = await buildModelCatalogFrom(ctx)()
    expect(catalog.groups).toEqual([{ id: 'ok', name: 'ok', models: [{ id: 'm', name: 'M' }] }])
  })

  it('宿主默认选择取不到 → default 为 null（不抛）', async () => {
    const ctx = fakeCtx({
      agentDefaultModel: {
        currentSelection: () => {
          throw new Error('no default')
        },
      },
      llm: { listProviders: () => [], listModels: async () => [] },
    })
    await expect(buildModelCatalogFrom(ctx)()).resolves.toEqual({ default: null, groups: [] })
  })
})
