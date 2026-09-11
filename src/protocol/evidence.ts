/**
 * Evidence 三要素校验（FUNCTIONS.md §4.5 / §7.4）——「无证据不进验收」不变量的守门代码。
 *
 * 校验规则（Host 强制，agent 工具调用侧执行）：
 * - changesSummary 非空；
 * - verification ≥ 1 条，每条 output 截断至 8KiB；
 * - selfCheck 与子任务 acceptance 逐条对应（同 id 集合、等长），缺条拒收；
 * - 结构化修正提示回给 agent（§8），不转状态。
 *
 * @module dsh-taskflow/protocol
 */

import { MAX_EVIDENCE_ARTIFACTS, MAX_VERIFICATION_OUTPUT_BYTES } from './types.ts'
import type { Artifact } from './types.ts'

export interface EvidenceInput {
  changesSummary: string
  verification: Array<{ label: string; output: string; passed: boolean }>
  selfCheck: Array<{ acceptanceId: string; verdict: 'pass' | 'partial' | 'fail'; note: string }>
  diffSummary?: string
  artifacts?: Artifact[]
}

export interface EvidenceRejection {
  problems: string[]
}

export class EvidenceRejectedError extends Error {
  readonly problems: string[]

  constructor(problems: string[]) {
    super(problems.join(' '))
    this.name = 'EvidenceRejectedError'
    this.problems = problems
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 解析 agent 工具入参为 EvidenceInput（形状级校验）。 */
export function parseEvidenceInput(raw: unknown): EvidenceInput {
  if (!isObject(raw)) throw new EvidenceRejectedError(['evidence must be an object.'])
  const problems: string[] = []
  if (typeof raw.changesSummary !== 'string' || raw.changesSummary.trim().length === 0) {
    problems.push('changesSummary must be a non-empty string（变更摘要缺失）.')
  }
  if (raw.changesSummary !== undefined && typeof raw.changesSummary === 'string' && raw.changesSummary.length > 16_000) {
    problems.push('changesSummary exceeds 16000 characters.')
  }
  if (!Array.isArray(raw.verification) || raw.verification.length === 0) {
    problems.push('verification must be a non-empty array（验证记录至少 1 条）.')
  } else {
    raw.verification.forEach((v, i) => {
      if (!isObject(v) || typeof v.label !== 'string' || v.label.trim().length === 0) {
        problems.push(`verification[${i}].label must be a non-empty string.`)
      }
      if (!isObject(v) || typeof v.output !== 'string') {
        problems.push(`verification[${i}].output must be a string.`)
      }
      if (!isObject(v) || typeof v.passed !== 'boolean') {
        problems.push(`verification[${i}].passed must be a boolean.`)
      }
    })
  }
  if (!Array.isArray(raw.selfCheck)) {
    problems.push('selfCheck must be an array（逐条自检缺失）.')
  } else {
    raw.selfCheck.forEach((s, i) => {
      if (!isObject(s) || typeof s.acceptanceId !== 'string' || s.acceptanceId.length === 0) {
        problems.push(`selfCheck[${i}].acceptanceId must be a non-empty string.`)
      }
      if (!isObject(s) || (s.verdict !== 'pass' && s.verdict !== 'partial' && s.verdict !== 'fail')) {
        problems.push(`selfCheck[${i}].verdict must be "pass" | "partial" | "fail".`)
      }
      if (!isObject(s) || typeof s.note !== 'string') {
        problems.push(`selfCheck[${i}].note must be a string.`)
      }
    })
  }
  if (raw.diffSummary !== undefined && typeof raw.diffSummary !== 'string') {
    problems.push('diffSummary must be a string.')
  }
  parseArtifacts(raw.artifacts, problems)
  if (problems.length > 0) throw new EvidenceRejectedError(problems)
  const input = raw as unknown as EvidenceInput
  return {
    changesSummary: input.changesSummary,
    verification: input.verification.map(v => ({ label: v.label, output: v.output, passed: v.passed })),
    selfCheck: input.selfCheck.map(s => ({ acceptanceId: s.acceptanceId, verdict: s.verdict, note: s.note })),
    ...(input.diffSummary === undefined ? {} : { diffSummary: input.diffSummary }),
    ...(normalizeArtifacts(input.artifacts) === undefined ? {} : { artifacts: normalizeArtifacts(input.artifacts) }),
  }
}

/** artifacts 形状校验（§4.5b：可选；path 必填且须为绝对路径）。 */
function parseArtifacts(value: unknown, problems: string[]): void {
  if (value === undefined) return
  if (!Array.isArray(value)) {
    problems.push('artifacts must be an array（交付物清单）.')
    return
  }
  if (value.length > MAX_EVIDENCE_ARTIFACTS) {
    problems.push(`artifacts must have at most ${MAX_EVIDENCE_ARTIFACTS} items.`)
  }
  value.forEach((item, i) => {
    if (!isObject(item) || typeof item.path !== 'string' || item.path.trim().length === 0) {
      problems.push(`artifacts[${i}].path must be a non-empty string.`)
      return
    }
    const p = item.path.trim()
    if (p.length > 4096) problems.push(`artifacts[${i}].path exceeds 4096 characters.`)
    if (!p.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(p)) {
      problems.push(`artifacts[${i}].path must be an absolute path（绝对路径）.`)
    }
    if (isObject(item) && item.description !== undefined && typeof item.description !== 'string') {
      problems.push(`artifacts[${i}].description must be a string.`)
    }
    if (isObject(item) && item.howVerified !== undefined && typeof item.howVerified !== 'string') {
      problems.push(`artifacts[${i}].howVerified must be a string.`)
    }
  })
}

/** artifacts 规范化：空数组 → undefined；path 去 blank；说明/核验说明截断。 */
function normalizeArtifacts(value: Artifact[] | undefined): Artifact[] | undefined {
  if (value === undefined || value.length === 0) return undefined
  return value.map(item => ({
    path: item.path.trim().slice(0, 4096),
    ...(item.description === undefined ? {} : { description: item.description.slice(0, 500) }),
    ...(item.howVerified === undefined ? {} : { howVerified: item.howVerified.slice(0, 1000) }),
  }))
}

/**
 * 语义校验 + 规范化：selfCheck 必须与 acceptance 逐条等长对应；output 截断。
 * 返回可直接落库的规范证据（caller 补 submittedAt / refs.sessionId）。
 */
export function normalizeEvidence(
  input: EvidenceInput,
  acceptanceIds: readonly string[],
): {
  changesSummary: string
  verification: Array<{ label: string; output: string; passed: boolean }>
  selfCheck: Array<{ acceptanceId: string; verdict: 'pass' | 'partial' | 'fail'; note: string }>
  diffSummary?: string
  artifacts?: Artifact[]
} {
  const problems: string[] = []
  const expected = new Set(acceptanceIds)
  const got = new Set(input.selfCheck.map(s => s.acceptanceId))
  for (const id of expected) {
    if (!got.has(id)) problems.push(`selfCheck 缺少验收条目 ${id} 的自检（必须逐条对应，不得跳条）.`)
  }
  for (const id of got) {
    if (!expected.has(id)) problems.push(`selfCheck 引用了不存在的验收条目 ${id}.`)
  }
  if (input.selfCheck.length !== acceptanceIds.length) {
    problems.push(`selfCheck 必须与验收标准等长（${acceptanceIds.length} 条），实际 ${input.selfCheck.length} 条.`)
  }
  const dup = input.selfCheck.map(s => s.acceptanceId).filter((id, i, arr) => arr.indexOf(id) !== i)
  if (dup.length > 0) problems.push(`selfCheck 存在重复条目：${[...new Set(dup)].join(', ')}.`)
  if (problems.length > 0) throw new EvidenceRejectedError(problems)

  // 截断顺序：先按字节截断再转回字符串（8KiB/条，§7.4）；TextEncoder 在宿主与浏览器一致
  const encoder = new TextEncoder()
  const decoder = new TextDecoder('utf-8')
  const truncate = (text: string): string => {
    const bytes = encoder.encode(text)
    if (bytes.byteLength <= MAX_VERIFICATION_OUTPUT_BYTES) return text
    const clipped = decoder.decode(bytes.subarray(0, MAX_VERIFICATION_OUTPUT_BYTES), { stream: true }) + decoder.decode()
    return `${clipped}\n…[截断至 8KiB]`
  }
  return {
    changesSummary: input.changesSummary,
    verification: input.verification.map(v => ({ label: v.label.slice(0, 200), output: truncate(v.output), passed: v.passed })),
    selfCheck: input.selfCheck.map(s => ({ acceptanceId: s.acceptanceId, verdict: s.verdict, note: s.note.slice(0, 2000) })),
    ...(input.diffSummary === undefined ? {} : { diffSummary: input.diffSummary.slice(0, 2000) }),
    ...(normalizeArtifacts(input.artifacts) === undefined ? {} : { artifacts: normalizeArtifacts(input.artifacts) }),
  }
}

/** 给 agent 的结构化修正提示（§8：submit_evidence 校验失败时回给会话）。 */
export function renderEvidenceCorrection(error: EvidenceRejectedError): string {
  return [
    'taskflow.submit_evidence 被拒收：证据不完整，无法进入待验收。请修正后重新提交。',
    '问题清单：',
    ...error.problems.map(p => `- ${p}`),
    '证据三要素必须齐全：1) changesSummary 变更摘要；2) verification ≥1 条（label/output/passed）；3) selfCheck 与验收标准逐条等长对应。',
  ].join('\n')
}
