/**
 * 任务模板库（FR-19）：dataDir/templates.json，与 ledger/settings 并列。
 *
 * - 形状校验 fail-closed（同 GlobalSettings 风格）；损坏 → 回退内置种子并记录
 *   lastLoadError（非关键数据，不阻塞启动）；
 * - 首次运行（缺文件）播种内置模板（创建 30 秒内完成的助推，§9 成功指标）；
 * - 全量 PUT（客户端「存为模板 / 删除」都以整表提交，服务端整体校验落盘）；
 * - 原子写：临时文件 + fsync + rename，0600。
 *
 * @module dsh-taskflow/host
 */

import path from 'node:path'
import { open, rename, mkdir, readFile } from 'node:fs/promises'
import type { TaskTemplate, TemplatePins } from '../protocol/types.ts'

export type { TaskTemplate } from '../protocol/types.ts'

export interface TemplateFile {
  schemaVersion: 1
  templates: TaskTemplate[]
}

export class TemplateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TemplateError'
  }
}

/** 内置种子模板（首次运行播种；用户可删可改，文件即所有权）。 */
export const DEFAULT_TEMPLATES: TaskTemplate[] = [
  {
    id: 'tpl_bugfix',
    name: '修 Bug',
    title: '',
    description: '现象：\n复现步骤：\n期望行为：\n',
    acceptance: ['复现步骤下不再出现原现象', '补回归测试覆盖该路径', '相关测试全绿'],
  },
  {
    id: 'tpl_feature',
    name: '新功能',
    title: '',
    description: '背景：\n想要什么：\n不要什么（范围外）：\n',
    acceptance: ['功能按描述可用', '带自测（测试或验证命令输出）', '不破坏既有行为'],
  },
  {
    id: 'tpl_research',
    name: '技术调研',
    title: '',
    description: '问题：\n候选方案：\n决策需要的信息：\n',
    acceptance: ['产出调研报告（Markdown，声明为交付物）', '每候选含优缺点与适用面', '给出明确建议与理由'],
  },
  {
    id: 'tpl_cleanup',
    name: '清理整理',
    title: '',
    description: '整理对象：\n整理目标：\n',
    acceptance: ['整理前后对比（清单/统计）', '产出整理报告（Markdown，声明为交付物）', '被整理内容可追溯（移入何处/删除依据）'],
  },
]

const MAX_TEMPLATES = 50
const MAX_TEXT = 4000

/** 校验一份全表提交 / 存量文件；非法即抛 TemplateError。 */
export function validateTemplates(raw: unknown): TaskTemplate[] {
  if (!Array.isArray(raw)) throw new TemplateError('templates 必须是数组')
  if (raw.length > MAX_TEMPLATES) throw new TemplateError(`模板数量上限 ${MAX_TEMPLATES}`)
  const seen = new Set<string>()
  return raw.map((item, i) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new TemplateError(`templates[${i}] 必须是对象`)
    }
    const value = item as Record<string, unknown>
    for (const key of Object.keys(value)) {
      if (key !== 'id' && key !== 'name' && key !== 'title' && key !== 'description' && key !== 'acceptance' && key !== 'pins') {
        throw new TemplateError(`templates[${i}] 未知字段：${key}`)
      }
    }
    const id = requireString(value.id, `templates[${i}].id`, 128)
    if (!/^tpl_[a-z0-9_]+$/.test(id)) throw new TemplateError(`templates[${i}].id 形如 tpl_xxx（小写字母数字下划线）`)
    if (seen.has(id)) throw new TemplateError(`templates[${i}].id 重复：${id}`)
    seen.add(id)
    const template: TaskTemplate = {
      id,
      name: requireNonEmpty(value.name, `templates[${i}].name`, 60),
      title: optionalString(value.title, `templates[${i}].title`, 120),
      description: optionalString(value.description, `templates[${i}].description`, MAX_TEXT),
      acceptance: validateAcceptance(value.acceptance, `templates[${i}].acceptance`),
    }
    if (value.pins !== undefined) template.pins = validatePins(value.pins, `templates[${i}].pins`)
    return template
  })
}

function validateAcceptance(raw: unknown, field: string): string[] {
  if (!Array.isArray(raw)) throw new TemplateError(`${field} 必须是数组`)
  if (raw.length > 20) throw new TemplateError(`${field} 上限 20 条`)
  return raw.map((item, i) => requireString(item, `${field}[${i}]`, 2000))
}

function validatePins(raw: unknown, field: string): TemplatePins {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new TemplateError(`${field} 必须是对象`)
  }
  const value = raw as Record<string, unknown>
  for (const key of Object.keys(value)) {
    if (key !== 'permission' && key !== 'executionMode' && key !== 'presetId' && key !== 'workspace') {
      throw new TemplateError(`${field} 未知字段：${key}`)
    }
  }
  const pins: TemplatePins = {}
  if (value.permission !== undefined) pins.permission = requireString(value.permission, `${field}.permission`, 64)
  if (value.executionMode !== undefined) {
    if (value.executionMode !== 'auto' && value.executionMode !== 'approval') {
      throw new TemplateError(`${field}.executionMode 必须是 auto / approval`)
    }
    pins.executionMode = value.executionMode
  }
  if (value.presetId !== undefined) {
    pins.presetId = value.presetId === null ? null : requireString(value.presetId, `${field}.presetId`, 128)
  }
  if (value.workspace !== undefined) pins.workspace = requireString(value.workspace, `${field}.workspace`, 1024)
  return pins
}

function requireString(raw: unknown, field: string, max: number): string {
  if (typeof raw !== 'string') throw new TemplateError(`${field} 必须是字符串`)
  if (raw.length > max) throw new TemplateError(`${field} 超过 ${max} 字符`)
  return raw
}

function optionalString(raw: unknown, field: string, max: number): string {
  if (raw === undefined) return ''
  return requireString(raw, field, max)
}

/** 模板存储（内存权威 + 原子落盘）。 */
export class TemplateStore {
  private templates: TaskTemplate[] = DEFAULT_TEMPLATES.map(t => structuredClone(t))
  lastLoadError: string | null = null

  constructor(readonly filePath: string) {}

  /** 缺文件 → 播种内置模板并落盘；损坏 → 内置模板 + lastLoadError。 */
  async load(): Promise<void> {
    this.lastLoadError = null
    let raw: string
    try {
      raw = await readFile(this.filePath, 'utf8')
    } catch {
      await this.update(DEFAULT_TEMPLATES).catch(() => undefined)
      return
    }
    try {
      const parsed = JSON.parse(raw) as unknown
      this.templates = validateTemplates(Array.isArray(parsed) ? parsed : (parsed as { templates?: unknown }).templates)
    } catch (error) {
      this.templates = DEFAULT_TEMPLATES.map(t => structuredClone(t))
      this.lastLoadError = error instanceof Error ? error.message : String(error)
    }
  }

  get(): TaskTemplate[] {
    return structuredClone(this.templates)
  }

  async update(raw: unknown): Promise<TaskTemplate[]> {
    const next = validateTemplates(raw)
    await this.atomicWrite(next)
    this.templates = next
    return structuredClone(next)
  }

  private async atomicWrite(templates: TaskTemplate[]): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true })
    const tmp = `${this.filePath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
    const payload = JSON.stringify({ schemaVersion: 1, templates }, null, 2)
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
      await import('node:fs/promises').then(fs => fs.unlink(tmp)).catch(() => {})
      throw error
    }
  }
}

function requireNonEmpty(raw: unknown, field: string, max: number): string {
  if (typeof raw !== 'string' || raw.trim().length === 0) throw new TemplateError(`${field} 必须是非空字符串`)
  if (raw.length > max) throw new TemplateError(`${field} 超过 ${max} 字符`)
  return raw
}
