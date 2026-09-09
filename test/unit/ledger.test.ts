import { readFile, writeFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { LedgerStore, LedgerWriteError } from '../../src/host/ledger.ts'
import type { Ledger } from '../../src/protocol/types.ts'
import { cleanup, tempDir } from '../helpers.ts'

function seedTask(ledger: Ledger, id: string): void {
  ledger.tasks.push({
    id,
    title: `任务 ${id}`,
    description: '描述',
    contract: { objective: '目标', acceptance: [], sourceOfAcceptance: 'human', pins: { workspace: '/tmp', presetId: null, permission: 'read-only' } },
    status: 'draft',
    subtasks: [],
    events: [],
    round: 1,
    maxRounds: 3,
    createdAt: 1,
    updatedAt: 1,
    createdBy: 'human',
    autoStart: true,
    permissionConfirmed: true,
    decomposeSessionIds: [],
  })
}

describe('LedgerStore', () => {
  it('原子写并持久化（重启加载一致，revision 单调）', async () => {
    const dir = await tempDir()
    try {
      const file = path.join(dir, 'taskflow', 'ledger.json')
      const store = new LedgerStore(file)
      await store.load()
      await store.mutate(l => seedTask(l, 'tf_a'))
      await store.mutate(l => seedTask(l, 'tf_b'))
      expect(store.snapshot().revision).toBe(2)

      const store2 = new LedgerStore(file)
      const health = await store2.load()
      expect(health.corrupt).toBeNull()
      expect(store2.snapshot().tasks.map(t => t.id)).toEqual(['tf_a', 'tf_b'])
      expect(store2.snapshot().revision).toBe(2)
    } finally {
      await cleanup(dir)
    }
  })

  it('损坏文件移入 .corrupt-* 保留原始字节，不静默清空（NFR-09）', async () => {
    const dir = await tempDir()
    try {
      const file = path.join(dir, 'ledger.json')
      await writeFile(file, '{ this is not json !!!', 'utf8')
      const store = new LedgerStore(file)
      const health = await store.load()
      expect(health.corrupt).not.toBeNull()
      expect(health.corrupt?.movedTo).toContain('.corrupt-')
      // 原始字节保留
      const raw = await readFile(health.corrupt!.movedTo, 'utf8')
      expect(raw).toBe('{ this is not json !!!')
      // 以空 ledger 启动，可继续写
      expect(store.snapshot().tasks).toHaveLength(0)
      await store.mutate(l => seedTask(l, 'tf_c'))
      expect(store.snapshot().tasks).toHaveLength(1)
    } finally {
      await cleanup(dir)
    }
  })

  it('schema 不匹配（如缺 tasks）同样隔离', async () => {
    const dir = await tempDir()
    try {
      const file = path.join(dir, 'ledger.json')
      await writeFile(file, JSON.stringify({ schemaVersion: 1, revision: 5 }), 'utf8')
      const store = new LedgerStore(file)
      const health = await store.load()
      expect(health.corrupt).not.toBeNull()
      expect(store.snapshot().tasks).toHaveLength(0)
    } finally {
      await cleanup(dir)
    }
  })

  it('写失败：内存回滚为磁盘态并抛 LedgerWriteError（§8 磁盘权威）', async () => {
    // /dev/null 之下 mkdir 必然 ENOTDIR → 原子写失败
    const store = new LedgerStore('/dev/null/taskflow/ledger.json')
    await store.load()
    await expect(store.mutate(l => seedTask(l, 'tf_x'))).rejects.toBeInstanceOf(LedgerWriteError)
    expect(store.snapshot().tasks).toHaveLength(0)
    expect(store.snapshot().revision).toBe(0)
    expect(store.health.lastWriteFailed).toBe(true)
  })

  it('mutate 串行互斥；订阅者在落盘后收到快照', async () => {
    const dir = await tempDir()
    try {
      const store = new LedgerStore(path.join(dir, 'ledger.json'))
      await store.load()
      const seen: number[] = []
      store.subscribe(l => seen.push(l.revision))
      await Promise.all([
        store.mutate(l => seedTask(l, 'tf_1')),
        store.mutate(l => seedTask(l, 'tf_2')),
        store.mutate(l => seedTask(l, 'tf_3')),
      ])
      expect(store.snapshot().tasks).toHaveLength(3)
      expect(store.snapshot().revision).toBe(3)
      expect(seen).toEqual([1, 2, 3])
    } finally {
      await cleanup(dir)
    }
  })

  it('落盘文件权限 0600（§7.5）', async () => {
    const dir = await tempDir()
    try {
      const file = path.join(dir, 'ledger.json')
      const store = new LedgerStore(file)
      await store.load()
      await store.mutate(l => seedTask(l, 'tf_perm'))
      const stat = await import('node:fs/promises').then(fs => fs.stat(file))
      expect(stat.mode & 0o777).toBe(0o600)
      const entries = await readdir(dir)
      expect(entries.some(e => e.startsWith('ledger.json.tmp-'))).toBe(false)
    } finally {
      await cleanup(dir)
    }
  })
})
