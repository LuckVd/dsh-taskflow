/**
 * Ledger 存储：临时文件 + 原子 rename，0600 权限，损坏保留（NFR-03/09，§7.5）。
 *
 * 写失败语义（§8）：保留原文件，内存态回滚为磁盘态（磁盘权威）。
 *
 * @module dsh-taskflow/host
 */

import { open, rename, mkdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import type { Ledger } from '../protocol/types.ts'

export const SCHEMA_VERSION = 1 as const

export class LedgerWriteError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'LedgerWriteError'
  }
}

export interface LedgerHealth {
  /** 上次加载时发现的损坏（文件已移入 .corrupt-*，原始字节保留）。 */
  corrupt: { originalPath: string; movedTo: string; at: number } | null
  /** 上次写入是否失败（内存态已回滚）。 */
  lastWriteFailed: boolean
}

function emptyLedger(): Ledger {
  return { schemaVersion: SCHEMA_VERSION, revision: 0, tasks: [] }
}

function isLedger(value: unknown): value is Ledger {
  if (typeof value !== 'object' || value === null) return false
  const ledger = value as Record<string, unknown>
  return ledger.schemaVersion === SCHEMA_VERSION
    && typeof ledger.revision === 'number'
    && Array.isArray(ledger.tasks)
}

/**
 * 单写者 ledger。所有变更经 {@link mutate}：互斥串行、revision+1、原子落盘、变更后通知订阅者。
 * 读方一律拿快照（structuredClone），浏览器只是异步视图（不变量 1）。
 */
export class LedgerStore {
  private ledger: Ledger = emptyLedger()
  private mutex: Promise<unknown> = Promise.resolve()
  private readonly listeners = new Set<(ledger: Ledger) => void>()
  readonly health: LedgerHealth = { corrupt: null, lastWriteFailed: false }

  constructor(readonly filePath: string) {}

  /** 加载；损坏 → 移入 .corrupt-<ts> 保留原始字节，以空 ledger + health.corrupt 启动。 */
  async load(): Promise<LedgerHealth> {
    if (!existsSync(this.filePath)) {
      this.ledger = emptyLedger()
      return this.health
    }
    let raw: string
    try {
      raw = await readFile(this.filePath, 'utf8')
    } catch (error) {
      this.health.corrupt = await this.quarantine(new Error(`unreadable: ${errorMessage(error)}`))
      return this.health
    }
    try {
      const parsed: unknown = JSON.parse(raw)
      if (!isLedger(parsed)) throw new Error('schema mismatch')
      this.ledger = parsed
      this.health.corrupt = null
    } catch (error) {
      this.health.corrupt = await this.quarantine(error)
    }
    return this.health
  }

  /** 损坏隔离：rename 保留原始字节（绝不静默清空）；rename 本身失败则原文件保留原状。 */
  private async quarantine(cause: unknown): Promise<{ originalPath: string; movedTo: string; at: number }> {
    const movedTo = `${this.filePath}.corrupt-${Date.now()}`
    try {
      await rename(this.filePath, movedTo)
    } catch {
      // 保留原状；health 标记已足够让 UI 显式报错
    }
    this.ledger = emptyLedger()
    void cause
    return { originalPath: this.filePath, movedTo, at: Date.now() }
  }

  /** 只读快照（深拷贝）。 */
  snapshot(): Ledger {
    return structuredClone(this.ledger)
  }

  subscribe(listener: (ledger: Ledger) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * 串行变更：fn 直接改 ledger → revision+1 → 原子写。
   * 写失败：内存回滚为写前快照（磁盘权威），health.lastWriteFailed 置位，抛 LedgerWriteError。
   */
  async mutate<T>(fn: (ledger: Ledger) => T): Promise<{ result: T; ledger: Ledger }> {
    const run = this.mutex.then(async () => {
      const before = structuredClone(this.ledger)
      let result: T
      try {
        result = fn(this.ledger)
      } catch (error) {
        this.ledger = before
        throw error
      }
      this.ledger.revision += 1
      try {
        await this.atomicWrite(this.ledger)
        this.health.lastWriteFailed = false
      } catch (error) {
        this.ledger = before
        this.health.lastWriteFailed = true
        throw new LedgerWriteError(`ledger write failed: ${errorMessage(error)}`, { cause: error })
      }
      const snapshot = structuredClone(this.ledger)
      for (const listener of this.listeners) {
        try {
          listener(snapshot)
        } catch {
          // 订阅者异常不影响权威状态
        }
      }
      return { result, ledger: snapshot }
    })
    // 串行链：后续 mutate 等待本次完成（含失败）
    this.mutex = run.then(() => undefined, () => undefined)
    return run
  }

  /** 临时文件 + fsync + rename；0600。 */
  private async atomicWrite(ledger: Ledger): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true })
    const tmp = `${this.filePath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
    const payload = JSON.stringify(ledger)
    try {
      const handle = await open(tmp, 'w', 0o600)
      try {
        await handle.writeFile(payload, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(tmp, this.filePath)
    } catch (error) {
      try {
        await import('node:fs/promises').then(fs => fs.unlink(tmp)).catch(() => {})
      } catch {
        // 清理失败可接受
      }
      throw error
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
