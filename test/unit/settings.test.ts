/**
 * 全局模型设置：形状校验、持久化存储、留痕标签（§PLAN-MODEL）。
 */
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_MODEL_SETTINGS, ModelSettingsStore, modelLabel, validateModelSettings } from '../../src/host/settings.ts'
import { cleanup, tempDir } from '../helpers.ts'

describe('validateModelSettings（fail-closed 形状校验）', () => {
  it('两槽全 null = 默认（跟随宿主）', () => {
    expect(validateModelSettings({})).toEqual(DEFAULT_MODEL_SETTINGS)
    expect(validateModelSettings({ decompose: null, execution: null })).toEqual(DEFAULT_MODEL_SETTINGS)
  })

  it('合法 selection 透传并 trim', () => {
    const next = validateModelSettings({
      decompose: { provider: ' deepseek ', model: ' deepseek-reasoner ', reasoningEffort: ' high ' },
      execution: { provider: 'ollama', model: 'qwen3:8b' },
    })
    expect(next.decompose).toEqual({ provider: 'deepseek', model: 'deepseek-reasoner', reasoningEffort: 'high' })
    expect(next.execution).toEqual({ provider: 'ollama', model: 'qwen3:8b' })
  })

  it('拒绝：非对象 / 未知槽位 / selection 未知字段 / 空字符串', () => {
    expect(() => validateModelSettings('nope')).toThrow()
    expect(() => validateModelSettings(null)).toThrow()
    expect(() => validateModelSettings([])).toThrow()
    expect(() => validateModelSettings({ decompose: null, other: null })).toThrow(/未知字段/)
    expect(() => validateModelSettings({ decompose: { provider: 'p', model: 'm', extra: 1 } })).toThrow(/未知字段/)
    expect(() => validateModelSettings({ decompose: { provider: '', model: 'm' } })).toThrow(/provider/)
    expect(() => validateModelSettings({ execution: { provider: 'p' } })).toThrow(/model/)
    expect(() => validateModelSettings({ execution: { provider: 'p', model: 'm', reasoningEffort: ' ' } })).toThrow(/reasoningEffort/)
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

describe('ModelSettingsStore（原子落盘 + 损坏回退）', () => {
  it('缺文件 load → 默认；update 落盘可回读', async () => {
    const dir = await tempDir()
    try {
      const file = path.join(dir, 'settings.json')
      const store = new ModelSettingsStore(file)
      await store.load()
      expect(store.get()).toEqual(DEFAULT_MODEL_SETTINGS)
      const next = await store.update({ execution: { provider: 'deepseek', model: 'deepseek-chat' } })
      expect(next.execution).toEqual({ provider: 'deepseek', model: 'deepseek-chat' })
      // 回读磁盘
      const onDisk = JSON.parse(await readFile(file, 'utf8'))
      expect(onDisk.execution.model).toBe('deepseek-chat')
      // 新实例读回
      const fresh = new ModelSettingsStore(file)
      await fresh.load()
      expect(fresh.get().execution?.model).toBe('deepseek-chat')
    } finally {
      await cleanup(dir)
    }
  })

  it('损坏文件 load → 回退默认并记录 lastLoadError；update 校验失败不改内存不落盘', async () => {
    const dir = await tempDir()
    try {
      const file = path.join(dir, 'settings.json')
      await writeFile(file, '{broken json', 'utf8')
      const store = new ModelSettingsStore(file)
      await store.load()
      expect(store.get()).toEqual(DEFAULT_MODEL_SETTINGS)
      expect(store.lastLoadError).toBeTruthy()
      await expect(store.update({ execution: { provider: '' } })).rejects.toThrow()
      await store.update({ decompose: { provider: 'p', model: 'm' } })
      expect(JSON.parse(await readFile(file, 'utf8')).decompose.model).toBe('m')
    } finally {
      await cleanup(dir)
    }
  })
})
