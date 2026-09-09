/**
 * 拆解会话结构化输出协议与校验（FUNCTIONS.md §4.3）。
 *
 * Host 对拆解会话产物做 schema 校验：不合法 → 重试一次 → 仍不合法 → 任务 blocked。
 *
 * @module dsh-taskflow/protocol
 */

/** 拆解会话必须返回的 JSON 形状。 */
export interface DecomposeOutput {
  taskAcceptance: Array<{ id?: string; text: string }>
  subtasks: Array<{
    title: string
    detail: string
    acceptance: Array<{ text: string }>
    deps: string[]
  }>
}

export class DecomposeValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DecomposeValidationError'
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function str(value: unknown, field: string, opts: { max: number; allowEmpty?: boolean }): string {
  if (typeof value !== 'string') throw new DecomposeValidationError(`${field} must be a string.`)
  if (!opts.allowEmpty && value.trim().length === 0) throw new DecomposeValidationError(`${field} must be non-empty.`)
  if (value.length > opts.max) throw new DecomposeValidationError(`${field} exceeds ${opts.max} characters.`)
  return value
}

/**
 * 校验拆解产物：
 * - schema 合法；
 * - 每个子任务 acceptance 非空（FR-03 强制）；
 * - 子任务数量 ≥ 1；
 * - deps 引用存在（按产出顺序内部引用）且无环（M2 起强制阻塞调度；这里直接拒绝环）。
 */
export function validateDecomposeOutput(raw: unknown): DecomposeOutput {
  if (!isObject(raw)) throw new DecomposeValidationError('decompose output must be an object.')
  if (!Array.isArray(raw.taskAcceptance)) {
    throw new DecomposeValidationError('taskAcceptance must be an array.')
  }
  const taskAcceptance = raw.taskAcceptance.map((item, i) => {
    if (!isObject(item)) throw new DecomposeValidationError(`taskAcceptance[${i}] must be an object.`)
    return { ...(item.id === undefined ? {} : { id: str(item.id, `taskAcceptance[${i}].id`, { max: 128, allowEmpty: true }) }), text: str(item.text, `taskAcceptance[${i}].text`, { max: 2000 }) }
  })
  if (taskAcceptance.length === 0) {
    throw new DecomposeValidationError('taskAcceptance must contain at least one item（拆解必须先补全任务级验收建议稿）.')
  }
  if (!Array.isArray(raw.subtasks) || raw.subtasks.length === 0) {
    throw new DecomposeValidationError('subtasks must be a non-empty array.')
  }
  if (raw.subtasks.length > 20) {
    throw new DecomposeValidationError('subtasks must not exceed 20 items.')
  }
  const titles = new Set<string>()
  const subtasks = raw.subtasks.map((item, i) => {
    if (!isObject(item)) throw new DecomposeValidationError(`subtasks[${i}] must be an object.`)
    const title = str(item.title, `subtasks[${i}].title`, { max: 120 })
    if (titles.has(title)) throw new DecomposeValidationError(`subtasks[${i}].title duplicates an earlier subtask.`)
    titles.add(title)
    const detail = str(item.detail, `subtasks[${i}].detail`, { max: 8000, allowEmpty: true })
    if (!Array.isArray(item.acceptance) || item.acceptance.length === 0) {
      throw new DecomposeValidationError(`subtasks[${i}].acceptance must be a non-empty array（子任务验收强制产出）.`)
    }
    const acceptance = item.acceptance.map((ac, j) => {
      if (!isObject(ac)) throw new DecomposeValidationError(`subtasks[${i}].acceptance[${j}] must be an object.`)
      return { text: str(ac.text, `subtasks[${i}].acceptance[${j}].text`, { max: 2000 }) }
    })
    const depsRaw = item.deps
    if (!Array.isArray(depsRaw)) throw new DecomposeValidationError(`subtasks[${i}].deps must be an array.`)
    return { title, detail, acceptance, deps: depsRaw }
  })

  // deps 在落库前指向产出顺序；这里校验自洽性：索引引用 [0, n) 且无环。
  const deps = subtasks.map((st, i) => {
    const out: string[] = []
    for (const dep of st.deps) {
      if (typeof dep !== 'string') throw new DecomposeValidationError(`subtasks[${i}].deps entries must be strings.`)
      const match = subtasks.findIndex((cand, j) => j !== i && (cand.title === dep || `s${j + 1}` === dep))
      if (match < 0) throw new DecomposeValidationError(`subtasks[${i}] depends on unknown "${dep}".`)
      out.push(`s${match + 1}`)
    }
    return out
  })
  assertAcyclic(deps)

  return { taskAcceptance, subtasks: subtasks.map((st, i) => ({ ...st, deps: deps[i] ?? [] })) }
}

/** deps 以索引位置表示（s1..sn），Floyd 环检测。 */
function assertAcyclic(depsByIndex: string[][]): void {
  const index = (dep: string) => Number.parseInt(dep.slice(1), 10) - 1
  const visiting = new Set<number>()
  const visited = new Set<number>()
  const visit = (i: number): void => {
    if (visited.has(i)) return
    if (visiting.has(i)) throw new DecomposeValidationError('subtask deps form a cycle.')
    visiting.add(i)
    for (const dep of depsByIndex[i] ?? []) visit(index(dep))
    visiting.delete(i)
    visited.add(i)
  }
  for (let i = 0; i < depsByIndex.length; i++) visit(i)
}
