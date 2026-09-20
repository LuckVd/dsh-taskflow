/**
 * Action 联合类型与白名单（FUNCTIONS.md §6）。
 *
 * 安全约束：白名单封闭；无命令/可执行路径/shell 文本字段；
 * workspace 路径仅出现在 createTask/updateContract 的 pins 中（Host 校验绝对路径）；
 * requestId 由客户端生成用于幂等去重。
 *
 * @module dsh-taskflow/protocol
 */

import { CAPABILITIES } from './types.ts'
import type { AcceptanceItem } from './types.ts'

export type TaskflowAction =
  | CreateTaskAction
  | StartDecomposeAction
  | UpdateContractAction
  | EditSubtasksAction
  | StartImplementationAction
  | ApproveSubtaskAction
  | RejectSubtaskAction
  | ApproveTaskAction
  | CancelTaskAction
  | ArchiveTaskAction
  | RetryBlockedAction
  | RaiseMaxRoundsAction
  | DecideApprovalAction
  | GenerateTaskEvidenceAction

export interface CreateTaskAction {
  type: 'createTask'
  requestId: string
  title: string
  description: string
  acceptance?: Array<{ text: string }>
  objective?: string
  pins?: Partial<{ workspace: string; presetId: string | null; permission: string; executionMode: import('./types.ts').ExecutionMode }>
  /** 能力预设（FR-22，可选）：id 须在 CAPABILITIES 内。 */
  capability?: string
  /** 任务级子任务并发上限（FR-23，可选，1–8）：缺省跟随全局设置。 */
  maxConcurrentSubtasks?: number
  autoStart?: boolean
  /** 创建后立即触发拆解（默认 true，对应 T2 的自动形态）。 */
  autoDecompose?: boolean
  maxRounds?: number | null
}

export interface StartDecomposeAction {
  type: 'startDecompose'
  requestId: string
  taskId: string
}

export interface UpdateContractAction {
  type: 'updateContract'
  requestId: string
  taskId: string
  objective?: string
  acceptance?: Array<{ id?: string; text: string }>
  pins?: Partial<{ workspace: string; presetId: string | null; permission: string; executionMode: import('./types.ts').ExecutionMode }>
  autoStart?: boolean
}

export interface EditSubtasksAction {
  type: 'editSubtasks'
  requestId: string
  taskId: string
  add?: Array<{ title: string; detail: string; acceptance: Array<{ text: string }>; deps?: string[] }>
  remove?: string[]
  update?: Array<{ id: string; title?: string; detail?: string; acceptance?: Array<{ id?: string; text: string }> }>
}

export interface StartImplementationAction {
  type: 'startImplementation'
  requestId: string
  taskId: string
  /** 权限确认门：pins 高于会话默认权限时必须显式携带（§7.1）。 */
  confirmPermission?: boolean
}

export interface ApproveSubtaskAction {
  type: 'approveSubtask'
  requestId: string
  taskId: string
  subtaskId: string
}

export interface RejectSubtaskAction {
  type: 'rejectSubtask'
  requestId: string
  taskId: string
  /**
   * 显式指定返工范围（API 高级路径）。缺省 = AI 定位（triage 会话把批语映射到
   * 返工集合，适配器不支持或定位失败时回退全量）——人只对任务合同负责，
   * 不选子任务（§4.6 2026-09-11 语义）。
   */
  subtaskIds?: string[]
  /** 打回批语，必填，原文注入下一轮执行。 */
  comment: string
}

export interface ApproveTaskAction {
  type: 'approveTask'
  requestId: string
  taskId: string
}

export interface CancelTaskAction {
  type: 'cancelTask'
  requestId: string
  taskId: string
  /** 二次确认标记：UI 必须先弹确认框再携带 confirm: true（§5.3）。 */
  confirm: boolean
}

export interface ArchiveTaskAction {
  type: 'archiveTask'
  requestId: string
  taskId: string
}

export interface RetryBlockedAction {
  type: 'retryBlocked'
  requestId: string
  taskId: string
  subtaskId?: string
}

export interface RaiseMaxRoundsAction {
  type: 'raiseMaxRounds'
  requestId: string
  taskId: string
  maxRounds: number | null
}

export interface DecideApprovalAction {
  type: 'decideApproval'
  requestId: string
  taskId: string
  approvalId: string
  /** allow = 完全放行（会话预设提升，后续不再逐次询问）；reject = 仅拒这一次调用。 */
  decision: 'allow' | 'reject'
  /** 裁决批语（可选，留痕）。 */
  note?: string
}

/** 手动补跑任务级终检（存量任务进 review 时无终检证据；FR-07 2026-09-11 语义）。 */
export interface GenerateTaskEvidenceAction {
  type: 'generateTaskEvidence'
  requestId: string
  taskId: string
}

export type ActionOfType<T extends TaskflowAction['type']> = Extract<TaskflowAction, { type: T }>

/** 合法 action 类型白名单（§6：封闭集合）。 */
export const ACTION_TYPES: ReadonlySet<string> = new Set<TaskflowAction['type']>([
  'createTask',
  'startDecompose',
  'updateContract',
  'editSubtasks',
  'startImplementation',
  'approveSubtask',
  'rejectSubtask',
  'approveTask',
  'cancelTask',
  'archiveTask',
  'retryBlocked',
  'raiseMaxRounds',
  'decideApproval',
  'generateTaskEvidence',
])

/** action 校验错误（不含宿主内部信息，可安全回给浏览器）。 */
export class ActionFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ActionFormatError'
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireString(value: unknown, field: string, opts: { max?: number; allowEmpty?: boolean } = {}): string {
  if (typeof value !== 'string') throw new ActionFormatError(`${field} must be a string.`)
  if (!opts.allowEmpty && value.trim().length === 0) throw new ActionFormatError(`${field} must be non-empty.`)
  if (opts.max !== undefined && value.length > opts.max) {
    throw new ActionFormatError(`${field} must be at most ${opts.max} characters.`)
  }
  return value
}

function optional<T>(value: unknown | undefined, parse: (v: unknown) => T): T | undefined {
  return value === undefined ? undefined : parse(value)
}

/** 校验 action 的形状（不校验状态机合法性——那是引擎的职责）。 */
export function validateActionShape(action: unknown): TaskflowAction {
  if (!isObject(action)) throw new ActionFormatError('action must be an object.')
  const type = requireString(action.type, 'type', { max: 64 })
  if (!ACTION_TYPES.has(type)) throw new ActionFormatError(`unknown action type "${type}".`)
  const requestId = requireString(action.requestId, 'requestId', { max: 128 })
  const rest: Record<string, unknown> = { ...action, type, requestId }

  switch (type as TaskflowAction['type']) {
    case 'createTask': {
      const title = requireString(action.title, 'title', { max: 120 })
      const description = requireString(action.description, 'description', { max: 65_536, allowEmpty: false })
      if (action.objective !== undefined) requireString(action.objective, 'objective', { max: 2000 })
      validateAcceptanceInput(action.acceptance, 'acceptance', { optional: true })
      validatePinsInput(action.pins, { optional: true })
      if (action.capability !== undefined && !CAPABILITIES.some(c => c.id === action.capability)) {
        throw new ActionFormatError(`capability must be one of: ${CAPABILITIES.map(c => c.id).join(', ')}.`)
      }
      if (action.maxConcurrentSubtasks !== undefined) {
        const value = action.maxConcurrentSubtasks
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 8) {
          throw new ActionFormatError('maxConcurrentSubtasks must be an integer between 1 and 8.')
        }
      }
      validateAutoStartFlag(action.autoStart)
      validateAutoDecomposeFlag(action.autoDecompose)
      validateMaxRounds(action.maxRounds)
      return { ...rest, title, description } as unknown as CreateTaskAction
    }
    case 'startDecompose':
      requireString(action.taskId, 'taskId', { max: 128 })
      return rest as unknown as StartDecomposeAction
    case 'updateContract': {
      requireString(action.taskId, 'taskId', { max: 128 })
      if (action.objective !== undefined) requireString(action.objective, 'objective', { max: 2000 })
      validateAcceptanceInput(action.acceptance, 'acceptance', { optional: true })
      validatePinsInput(action.pins, { optional: true })
      validateAutoStartFlag(action.autoStart)
      return rest as unknown as UpdateContractAction
    }
    case 'editSubtasks': {
      requireString(action.taskId, 'taskId', { max: 128 })
      validateEditLists(action)
      return rest as unknown as EditSubtasksAction
    }
    case 'startImplementation': {
      requireString(action.taskId, 'taskId', { max: 128 })
      if (action.confirmPermission !== undefined && typeof action.confirmPermission !== 'boolean') {
        throw new ActionFormatError('confirmPermission must be a boolean.')
      }
      return rest as unknown as StartImplementationAction
    }
    case 'approveSubtask': {
      requireString(action.taskId, 'taskId', { max: 128 })
      requireString(action.subtaskId, 'subtaskId', { max: 128 })
      return rest as unknown as ApproveSubtaskAction
    }
    case 'rejectSubtask': {
      requireString(action.taskId, 'taskId', { max: 128 })
      requireString(action.comment, 'comment', { max: 8000 })
      const subtaskIds = optional(action.subtaskIds, v => {
        if (!Array.isArray(v)) throw new ActionFormatError('subtaskIds must be an array.')
        return v.map(id => requireString(id, 'subtaskIds[]', { max: 128 }))
      })
      if (subtaskIds !== undefined && subtaskIds.length === 0) {
        throw new ActionFormatError('subtaskIds must not be empty when provided.')
      }
      return { ...rest, ...(subtaskIds === undefined ? {} : { subtaskIds }) } as RejectSubtaskAction
    }
    case 'approveTask':
      requireString(action.taskId, 'taskId', { max: 128 })
      return rest as unknown as ApproveTaskAction
    case 'cancelTask': {
      requireString(action.taskId, 'taskId', { max: 128 })
      if (action.confirm !== true) throw new ActionFormatError('cancelTask requires confirm: true (二次确认).')
      return rest as unknown as CancelTaskAction
    }
    case 'archiveTask':
      requireString(action.taskId, 'taskId', { max: 128 })
      return rest as unknown as ArchiveTaskAction
    case 'retryBlocked': {
      requireString(action.taskId, 'taskId', { max: 128 })
      if (action.subtaskId !== undefined) requireString(action.subtaskId, 'subtaskId', { max: 128 })
      return rest as unknown as RetryBlockedAction
    }
    case 'raiseMaxRounds': {
      requireString(action.taskId, 'taskId', { max: 128 })
      validateMaxRounds(action.maxRounds, { optional: false })
      return rest as unknown as RaiseMaxRoundsAction
    }
    case 'decideApproval': {
      requireString(action.taskId, 'taskId', { max: 128 })
      requireString(action.approvalId, 'approvalId', { max: 128 })
      if (action.decision !== 'allow' && action.decision !== 'reject') {
        throw new ActionFormatError('decision must be "allow" or "reject".')
      }
      if (action.note !== undefined) requireString(action.note, 'note', { max: 500, allowEmpty: true })
      return rest as unknown as DecideApprovalAction
    }
    case 'generateTaskEvidence':
      requireString(action.taskId, 'taskId', { max: 128 })
      return rest as unknown as GenerateTaskEvidenceAction
  }
}

function validateAcceptanceInput(
  value: unknown,
  field: string,
  opts: { optional: boolean },
): void {
  if (value === undefined) {
    if (!opts.optional) throw new ActionFormatError(`${field} is required.`)
    return
  }
  if (!Array.isArray(value)) throw new ActionFormatError(`${field} must be an array.`)
  if (value.length === 0) throw new ActionFormatError(`${field} must not be empty when provided.`)
  for (const [i, item] of value.entries()) {
    if (!isObject(item)) throw new ActionFormatError(`${field}[${i}] must be an object.`)
    if (item.id !== undefined) requireString(item.id, `${field}[${i}].id`, { max: 128 })
    requireString(item.text, `${field}[${i}].text`, { max: 2000 })
  }
}

function validatePinsInput(value: unknown, opts: { optional: boolean }): void {
  if (value === undefined) {
    if (!opts.optional) throw new ActionFormatError('pins is required.')
    return
  }
  if (!isObject(value)) throw new ActionFormatError('pins must be an object.')
  const allowed = new Set(['workspace', 'presetId', 'permission', 'executionMode'])
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new ActionFormatError(`pins.${key} is not allowed.`)
  }
  if (value.executionMode !== undefined && value.executionMode !== 'auto' && value.executionMode !== 'approval') {
    throw new ActionFormatError('pins.executionMode must be "auto" or "approval".')
  }
  if (value.workspace !== undefined) {
    const ws = requireString(value.workspace, 'pins.workspace', { max: 4096 })
    if (!ws.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(ws)) {
      throw new ActionFormatError('pins.workspace must be an absolute path.')
    }
  }
  if (value.presetId !== undefined && value.presetId !== null) {
    requireString(value.presetId, 'pins.presetId', { max: 256 })
  }
  if (value.permission !== undefined) {
    requireString(value.permission, 'pins.permission', { max: 128 })
  }
}

function validateAutoStartFlag(value: unknown): void {
  if (value !== undefined && typeof value !== 'boolean') throw new ActionFormatError('autoStart must be a boolean.')
}

function validateAutoDecomposeFlag(value: unknown): void {
  if (value !== undefined && typeof value !== 'boolean') throw new ActionFormatError('autoDecompose must be a boolean.')
}

function validateMaxRounds(value: unknown, opts: { optional: boolean } = { optional: true }): void {
  if (value === undefined) {
    if (!opts.optional) throw new ActionFormatError('maxRounds is required.')
    return
  }
  if (value === null) return
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 99) {
    throw new ActionFormatError('maxRounds must be a safe integer in [1, 99] or null.')
  }
}

function validateEditLists(action: Record<string, unknown>): void {
  const hasAny = action.add !== undefined || action.remove !== undefined || action.update !== undefined
  if (!hasAny) throw new ActionFormatError('editSubtasks requires at least one of add/remove/update.')
  const add = optional(action.add, v => {
    if (!Array.isArray(v) || v.length === 0) throw new ActionFormatError('add must be a non-empty array.')
    return v.map((item, i) => {
      if (!isObject(item)) throw new ActionFormatError(`add[${i}] must be an object.`)
      requireString(item.title, `add[${i}].title`, { max: 120 })
      requireString(item.detail, `add[${i}].detail`, { max: 8000, allowEmpty: true })
      if (item.detail === undefined) (item as Record<string, unknown>).detail = ''
      validateAcceptanceInput(item.acceptance, `add[${i}].acceptance`, { optional: false })
      if (item.deps !== undefined) {
        if (!Array.isArray(item.deps)) throw new ActionFormatError(`add[${i}].deps must be an array.`)
        for (const dep of item.deps) requireString(dep, `add[${i}].deps[]`, { max: 128 })
      }
      return item
    })
  })
  if (add === undefined && action.add !== undefined) throw new ActionFormatError('add must be a non-empty array.')
  const remove = optional(action.remove, v => {
    if (!Array.isArray(v) || v.length === 0) throw new ActionFormatError('remove must be a non-empty array.')
    return v.map(id => requireString(id, 'remove[]', { max: 128 }))
  })
  if (remove === undefined && action.remove !== undefined) throw new ActionFormatError('remove must be a non-empty array.')
  const update = optional(action.update, v => {
    if (!Array.isArray(v) || v.length === 0) throw new ActionFormatError('update must be a non-empty array.')
    return v.map((item, i) => {
      if (!isObject(item)) throw new ActionFormatError(`update[${i}] must be an object.`)
      requireString(item.id, `update[${i}].id`, { max: 128 })
      if (item.title !== undefined) requireString(item.title, `update[${i}].title`, { max: 120 })
      if (item.detail !== undefined) requireString(item.detail, `update[${i}].detail`, { max: 8000, allowEmpty: true })
      if (item.acceptance !== undefined) validateAcceptanceInput(item.acceptance, `update[${i}].acceptance`, { optional: false })
      return item
    })
  })
  if (update === undefined && action.update !== undefined) throw new ActionFormatError('update must be a non-empty array.')
}

/** AcceptanceItem 数组的规范化输入（含 id 继承：编辑时保留原 id 以维持可追溯，§4.2）。 */
export type AcceptanceInput = ReadonlyArray<{ id?: string; text: string }>

export function materializeAcceptance(input: AcceptanceInput, existing: AcceptanceItem[] = []): AcceptanceItem[] {
  return input.map(item => {
    const kept = item.id !== undefined ? existing.find(a => a.id === item.id) : undefined
    return { id: kept?.id ?? item.id ?? `ac_${randomId()}`, text: item.text }
  })
}

let idCounter = 0
/** 可注入的 id 后缀生成器（测试用确定性 id）。 */
export function randomId(bytes = 8): string {
  idCounter++
  const rand = Math.random().toString(36).slice(2, 10)
  return `${Date.now().toString(36)}${rand}${idCounter.toString(36)}`.slice(0, bytes * 2)
}
