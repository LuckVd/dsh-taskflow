/**
 * 全局设置（模型两槽 + 调度并发）：形状校验、持久化存储、留痕标签（§PLAN-MODEL / FR-13）。
 */
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_GLOBAL_SETTINGS, GlobalSettingsStore, modelLabel, validateGlobalSettings } from '../../src/host/settings.ts'
import { cleanup, tempDir } from '../helpers.ts'

describe('validateGlobalSettings（fail-closed 形状校验）', () => {
  it('两槽全 null = 默认（跟随宿主）', () => {
    expect(validateGlobalSettings({})).toEqual(DEFAULT_GLOBAL_SETTINGS)
    expect(validateGlobalSettings({ decompose: null, execution: null })).toEqual(DEFAULT_GLOBAL_SETTINGS)
  })

  it('合法 selection 透传并 trim', () => {
    const next = validateGlobalSettings({
      decompose: { provider: ' deepseek ', model: ' deepseek-reasoner ', reasoningEffort: ' high ' },
      execution: { provider: 'ollama', model: 'qwen3:8b' },
    })
    expect(next.decompose).toEqual({ provider: 'deepseek', model: 'deepseek-reasoner', reasoningEffort: 'high' })
    expect(next.execution).toEqual({ provider: 'ollama', model: 'qwen3:8b' })
  })

  it('拒绝：非对象 / 未知槽位 / selection 未知字段 / 空字符串', () => {
    expect(() => validateGlobalSettings('nope')).toThrow()
    expect(() => validateGlobalSettings(null)).toThrow()
    expect(() => validateGlobalSettings([])).toThrow()
    expect(() => validateGlobalSettings({ decompose: null, other: null })).toThrow(/未知字段/)
    expect(() => validateGlobalSettings({ decompose: { provider: 'p', model: 'm', extra: 1 } })).toThrow(/未知字段/)
    expect(() => validateGlobalSettings({ decompose: { provider: '', model: 'm' } })).toThrow(/provider/)
    expect(() => validateGlobalSettings({ execution: { provider: 'p' } })).toThrow(/model/)
    expect(() => validateGlobalSettings({ execution: { provider: 'p', model: 'm', reasoningEffort: ' ' } })).toThrow(/reasoningEffort/)
  })

  it('并发上限（FR-13）：1–8 整数合法，越界/非整数拒绝', () => {
    expect(validateGlobalSettings({ maxConcurrentSubtasks: 1 }).maxConcurrentSubtasks).toBe(1)
    expect(validateGlobalSettings({ maxConcurrentSubtasks: 8 }).maxConcurrentSubtasks).toBe(8)
    expect(validateGlobalSettings({}).maxConcurrentSubtasks).toBeUndefined()
    expect(() => validateGlobalSettings({ maxConcurrentSubtasks: 0 })).toThrow(/maxConcurrentSubtasks/)
    expect(() => validateGlobalSettings({ maxConcurrentSubtasks: 9 })).toThrow(/maxConcurrentSubtasks/)
    expect(() => validateGlobalSettings({ maxConcurrentSubtasks: 2.5 })).toThrow(/maxConcurrentSubtasks/)
    expect(() => validateGlobalSettings({ maxConcurrentSubtasks: '3' })).toThrow(/maxConcurrentSubtasks/)
  })
})

describe('modelLabel（留痕标签）', () => {
  it('null → undefined；带力度拼 ·effort', () => {
    expect(modelLabel(null)).toBeUndefined()
    expect(modelLabel({ provider: 'deepseek', model: 'deepseek-chat' })).toBe('deepseek/deepseek-chat')
    expect(modelLabel({ provider: 'deepseek', model: 'deepseek-reasoner', reasoningEffort: 'high' })).toBe(
      'deepseek/deepseek-reasoner·high',
    )
  })
})

describe('GlobalSettingsStore（原子落盘 + 损坏回退）', () => {
  it('缺文件 load → 默认；update 落盘可回读', async () => {
    const dir = await tempDir()
    try {
      const file = path.join(dir, 'settings.json')
      const store = new GlobalSettingsStore(file)
      await store.load()
      expect(store.get()).toEqual(DEFAULT_GLOBAL_SETTINGS)
      const next = await store.update({ execution: { provider: 'deepseek', model: 'deepseek-chat' } })
      expect(next.execution).toEqual({ provider: 'deepseek', model: 'deepseek-chat' })
      // 回读磁盘
      const onDisk = JSON.parse(await readFile(file, 'utf8'))
      expect(onDisk.execution.model).toBe('deepseek-chat')
      // 新实例读回
      const fresh = new GlobalSettingsStore(file)
      await fresh.load()
      expect(fresh.get().execution?.model).toBe('deepseek-chat')
    } finally {
      await cleanup(dir)
    }
  })

  it('并发上限随 settings.json 持久化（重启回读）', async () => {
    const dir = await tempDir()
    try {
      const file = path.join(dir, 'settings.json')
      const store = new GlobalSettingsStore(file)
      await store.update({ maxConcurrentSubtasks: 4 })
      const fresh = new GlobalSettingsStore(file)
      await fresh.load()
      expect(fresh.get().maxConcurrentSubtasks).toBe(4)
    } finally {
      await cleanup(dir)
    }
  })

  it('损坏文件 load → 回退默认并记录 lastLoadError；update 校验失败不改内存不落盘', async () => {
    const dir = await tempDir()
    try {
      const file = path.join(dir, 'settings.json')
      await writeFile(file, '{broken json', 'utf8')
      const store = new GlobalSettingsStore(file)
      await store.load()
      expect(store.get()).toEqual(DEFAULT_GLOBAL_SETTINGS)
      expect(store.lastLoadError).toBeTruthy()
      await expect(store.update({ execution: { provider: '' } })).rejects.toThrow()
      await store.update({ decompose: { provider: 'p', model: 'm' } })
      expect(JSON.parse(await readFile(file, 'utf8')).decompose.model).toBe('m')
    } finally {
      await cleanup(dir)
    }
  })
})
