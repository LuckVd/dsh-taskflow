/**
 * 任务模板库（FR-19）：校验、种子播种、持久化。
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_TEMPLATES, TemplateStore, validateTemplates } from '../../src/host/templates.ts'
import { cleanup, tempDir } from '../helpers.ts'

describe('validateTemplates（fail-closed 形状校验）', () => {
  it('内置种子合法', () => {
    expect(validateTemplates(DEFAULT_TEMPLATES)).toHaveLength(4)
  })

  it('合法模板透传；pins 子集可选', () => {
    const next = validateTemplates([
      { id: 'tpl_x1', name: '发布检查', title: '', description: 'd', acceptance: ['a', 'b'], pins: { executionMode: 'approval' } },
      { id: 'tpl_x2', name: '最小', title: '', description: '', acceptance: [] },
    ])
    expect(next[0]?.pins?.executionMode).toBe('approval')
    expect(next[1]?.pins).toBeUndefined()
  })

  it('拒绝：非数组 / 重复 id / 非法 id / 未知字段 / 越界条数', () => {
    expect(() => validateTemplates('nope')).toThrow()
    expect(() => validateTemplates([{ id: 'tpl_a', name: 'a', title: '', description: '', acceptance: [] }, { id: 'tpl_a', name: 'b', title: '', description: '', acceptance: [] }])).toThrow(/重复/)
    expect(() => validateTemplates([{ id: 'X!', name: 'a', title: '', description: '', acceptance: [] }])).toThrow(/tpl_xxx/)
    expect(() => validateTemplates([{ id: 'tpl_a', name: 'a', title: '', description: '', acceptance: [], extra: 1 }])).toThrow(/未知字段/)
    expect(() => validateTemplates([{ id: 'tpl_a', name: '', title: '', description: '', acceptance: [] }])).toThrow(/name/)
  })
})

describe('TemplateStore（种子播种 + 原子落盘 + 损坏回退）', () => {
  it('缺文件 → 播种内置模板并落盘；update 后新实例回读', async () => {
    const dir = await tempDir()
    try {
      const file = path.join(dir, 'templates.json')
      const store = new TemplateStore(file)
      await store.load()
      expect(store.get()).toHaveLength(4)
      const onDisk = JSON.parse(await readFile(file, 'utf8')) as { templates: unknown[] }
      expect(onDisk.templates).toHaveLength(4)

      await store.update([{ id: 'tpl_mine', name: '我的', title: 't', description: 'd', acceptance: ['x'] }])
      const fresh = new TemplateStore(file)
      await fresh.load()
      expect(fresh.get().map(t => t.id)).toEqual(['tpl_mine'])
    } finally {
      await cleanup(dir)
    }
  })

  it('损坏文件 → 回退内置种子并记录 lastLoadError；update 校验失败不改内存', async () => {
    const dir = await tempDir()
    try {
      const { writeFile } = await import('node:fs/promises')
      const file = path.join(dir, 'templates.json')
      await writeFile(file, '{broken', 'utf8')
      const store = new TemplateStore(file)
      await store.load()
      expect(store.get()).toHaveLength(4)
      expect(store.lastLoadError).toBeTruthy()
      await expect(store.update([{ id: 'bad', name: 'x', title: '', description: '', acceptance: [] }])).rejects.toThrow()
      expect(store.get()).toHaveLength(4)
    } finally {
      await cleanup(dir)
    }
  })
})
