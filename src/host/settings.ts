/**
 * 全局模型设置存储：dataDir/settings.json（与 ledger.json 并列，见 docs/PLAN-MODEL.md）。
 *
 * - 形状校验 fail-closed：非两槽结构 / 非法 selection 一律拒绝（HttpBadRequest 语义由调用层映射）；
 * - 损坏回退默认：settings 属非关键数据，load 失败不阻塞引擎（lastLoadError 留告警口）；
 * - 原子写：临时文件 + fsync + rename，0600（同 LedgerStore 形态）。
 *
 * @module dsh-taskflow/host
 */

import path from 'node:path'
import { open, rename, mkdir, readFile } from 'node:fs/promises'
import type { ModelSettings, SessionModelSelection } from '../protocol/types.ts'

export const DEFAULT_MODEL_SETTINGS: ModelSettings = { decompose: null, execution: null }

export class ModelSettingsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ModelSettingsError'
  }
}

/** 校验并归一化一次设置提交（PUT body / 存量文件共用）；非法即抛 ModelSettingsError。 */
export function validateModelSettings(raw: unknown): ModelSettings {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ModelSettingsError('settings 必须是对象（{ decompose, execution }）')
  }
  const record = raw as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (key !== 'decompose' && key !== 'execution') {
      throw new ModelSettingsError(`未知字段：${key}（仅允许 decompose / execution）`)
    }
  }
  return {
    decompose: validateSlot(record.decompose, 'decompose'),
    execution: validateSlot(record.execution, 'execution'),
  }
}

function validateSlot(raw: unknown, slot: string): SessionModelSelection | null {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ModelSettingsError(`${slot} 必须是 null 或 { provider, model }`)
  }
  const value = raw as Record<string, unknown>
  for (const key of Object.keys(value)) {
    if (key !== 'provider' && key !== 'model' && key !== 'reasoningEffort') {
      throw new ModelSettingsError(`${slot} 未知字段：${key}`)
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
    throw new ModelSettingsError(`${field} 必须是非空字符串`)
  }
  return raw.trim()
}

/** 模型标签（时间线/证据留痕用）：`provider/model`，带力度时 `provider/model·effort`；null → undefined。 */
export function modelLabel(selection: SessionModelSelection | null | undefined): string | undefined {
  if (selection === null || selection === undefined) return undefined
  return `${selection.provider}/${selection.model}${selection.reasoningEffort !== undefined ? `·${selection.reasoningEffort}` : ''}`
}

/** 全局模型设置存储（内存权威 + 原子落盘；engine 经 getter/setter 消费）。 */
export class ModelSettingsStore {
  private settings: ModelSettings = { ...DEFAULT_MODEL_SETTINGS }
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
      this.settings = validateModelSettings(JSON.parse(raw))
    } catch (error) {
      this.lastLoadError = error instanceof Error ? error.message : String(error)
    }
  }

  get(): ModelSettings {
    return structuredClone(this.settings)
  }

  /** 校验 + 原子落盘 + 内存生效；校验失败抛 ModelSettingsError（不落盘不改内存）。 */
  async update(raw: unknown): Promise<ModelSettings> {
    const next = validateModelSettings(raw)
    await this.atomicWrite(next)
    this.settings = next
    return structuredClone(next)
  }

  private async atomicWrite(settings: ModelSettings): Promise<void> {
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
