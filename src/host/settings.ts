/**
 * 全局设置存储：dataDir/settings.json（与 ledger.json 并列）。
 *
 * 内容 = 模型两槽（docs/PLAN-MODEL.md）+ 调度并发（FR-13 WIP 上限）。
 *
 * - 形状校验 fail-closed：非两槽结构 / 非法 selection / 并发越界一律拒绝
 *   （HttpBadRequest 语义由调用层映射）；
 * - 损坏回退默认：settings 属非关键数据，load 失败不阻塞引擎（lastLoadError 留告警口）；
 * - 原子写：临时文件 + fsync + rename，0600（同 LedgerStore 形态）。
 *
 * @module dsh-taskflow/host
 */

import path from 'node:path'
import { open, rename, mkdir, readFile } from 'node:fs/promises'
import type { GlobalSettings, SessionModelSelection } from '../protocol/types.ts'

export const DEFAULT_GLOBAL_SETTINGS: GlobalSettings = { decompose: null, execution: null }

/** 并发上限取值域（FR-13）：1 = 串行（M1 语义），8 = 单机资源护栏。 */
export const MAX_CONCURRENT_SUBTASKS_LIMIT = 8

export class SettingsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SettingsError'
  }
}

/** 校验并归一化一次设置提交（PUT body / 存量文件共用）；非法即抛 SettingsError。 */
export function validateGlobalSettings(raw: unknown): GlobalSettings {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new SettingsError('settings 必须是对象（{ decompose, execution, maxConcurrentSubtasks? }）')
  }
  const record = raw as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (key !== 'decompose' && key !== 'execution' && key !== 'maxConcurrentSubtasks' && key !== 'defaultPresetId') {
      throw new SettingsError(`未知字段：${key}（仅允许 decompose / execution / maxConcurrentSubtasks / defaultPresetId）`)
    }
  }
  let maxConcurrentSubtasks: number | undefined
  if (record.maxConcurrentSubtasks !== undefined) {
    const value = record.maxConcurrentSubtasks
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_CONCURRENT_SUBTASKS_LIMIT) {
      throw new SettingsError(`maxConcurrentSubtasks 必须是 1–${MAX_CONCURRENT_SUBTASKS_LIMIT} 的整数`)
    }
    maxConcurrentSubtasks = value
  }
  let defaultPresetId: string | null | undefined
  if (record.defaultPresetId !== undefined) {
    if (record.defaultPresetId !== null && typeof record.defaultPresetId !== 'string') {
      throw new SettingsError('defaultPresetId 必须是 null 或字符串')
    }
    defaultPresetId = record.defaultPresetId
  }
  return {
    decompose: validateSlot(record.decompose, 'decompose'),
    execution: validateSlot(record.execution, 'execution'),
    ...(maxConcurrentSubtasks !== undefined ? { maxConcurrentSubtasks } : {}),
    ...(defaultPresetId !== undefined ? { defaultPresetId } : {}),
  }
}

function validateSlot(raw: unknown, slot: string): SessionModelSelection | null {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new SettingsError(`${slot} 必须是 null 或 { provider, model }`)
  }
  const value = raw as Record<string, unknown>
  for (const key of Object.keys(value)) {
    if (key !== 'provider' && key !== 'model' && key !== 'reasoningEffort') {
      throw new SettingsError(`${slot} 未知字段：${key}`)
    }
  }
  const provider = requireNonEmptyString(value.provider, `${slot}.provider`)
  const model = requireNonEmptyString(value.model, `${slot}.model`)
  const effort = value.reasoningEffort === undefined ? undefined : requireNonEmptyString(value.reasoningEffort, `${slot}.reasoningEffort`)
  return {
    provider,
    model,
    ...(effort !== undefined ? { reasoningEffort: effort } : {}),
  }
}

function requireNonEmptyString(raw: unknown, field: string): string {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new SettingsError(`${field} 必须是非空字符串`)
  }
  return raw.trim()
}

/** 模型标签（时间线/证据留痕用）：`provider/model`，带力度时 `provider/model·effort`；null → undefined。 */
export function modelLabel(selection: SessionModelSelection | null | undefined): string | undefined {
  if (selection === null || selection === undefined) return undefined
  return `${selection.provider}/${selection.model}${selection.reasoningEffort !== undefined ? `·${selection.reasoningEffort}` : ''}`
}

/** 全局设置存储（内存权威 + 原子落盘；engine 经 getter/setter 消费）。 */
export class GlobalSettingsStore {
  private settings: GlobalSettings = { ...DEFAULT_GLOBAL_SETTINGS }
  /** 最近一次 load 失败的原因（非致命：回退默认继续运行）。 */
  lastLoadError: string | null = null

  constructor(readonly filePath: string) {}

  /** 缺文件 → 默认；损坏 → 回退默认并记录 lastLoadError（绝不阻塞启动）。 */
  async load(): Promise<void> {
    this.lastLoadError = null
    let raw: string
    try {
      raw = await readFile(this.filePath, 'utf8')
    } catch {
      return // 缺文件 = 首次运行
    }
    try {
      this.settings = validateGlobalSettings(JSON.parse(raw))
    } catch (error) {
      this.settings = { ...DEFAULT_GLOBAL_SETTINGS }
      this.lastLoadError = error instanceof Error ? error.message : String(error)
    }
  }

  get(): GlobalSettings {
    return structuredClone(this.settings)
  }

  /** 校验 + 原子落盘 + 内存生效；校验失败抛 SettingsError（不落盘不改内存）。 */
  async update(raw: unknown): Promise<GlobalSettings> {
    const next = validateGlobalSettings(raw)
    await this.atomicWrite(next)
    this.settings = next
    return structuredClone(next)
  }

  private async atomicWrite(settings: GlobalSettings): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true })
    const tmp = `${this.filePath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
    const payload = JSON.stringify(settings, null, 2)
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
