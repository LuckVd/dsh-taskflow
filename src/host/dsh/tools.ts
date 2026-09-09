/**
 * taskflow agent 工具面（§4.4）：在 taskflow 启动的会话的 scoped context
 * 上注册三个工具，仅该会话可见。校验与落库都在引擎（Host 权威），
 * 工具层只做桥接与呈现。
 *
 * 工具定义直接以编译后的 JSON Schema 形态声明（同宿主 defineTool 产物结构），
 * 不做 @deepseek-ai/dsh-tools 的运行时导入（见 compat.ts 头注）。
 *
 * @module dsh-taskflow/host
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
// 类型-only 导入：ToolDefinition 形状 + 宿主对 cordis Context 的服务增强（ctx.tools），零运行时依赖。
import type { ToolDefinition, JsonSchemaNode } from '@deepseek-ai/dsh-tools'
import type { AgentToolSurface } from '../engine.ts'

const VERDICT_ENUM = ['pass', 'partial', 'fail'] as const

/** 工具结果二态：受理（accepted: true）或附修正提示拒收。 */
const EVIDENCE_OUTPUT_SCHEMA: JsonSchemaNode = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: { accepted: { type: 'boolean', const: true } },
      required: ['accepted'],
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        accepted: { type: 'boolean', const: false },
        correction: { type: 'string' },
      },
      required: ['accepted', 'correction'],
    },
  ],
}

function renderJson(_args: unknown, value: unknown): ContentBlock[] {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

/** 注册结果（聚合 disposer）。 */
type Register = (definition: ToolDefinition) => unknown

/**
 * 注册三个 taskflow 工具（返回聚合 disposer）。
 * @param agentCtx 会话 scoped context（工具仅在该会话可见）
 * @param tools Host 权威工具面（引擎提供）
 * @param sessionId 本会话 id（绑定校验：仅本会话的证据受理）
 */
export function registerTaskflowTools(agentCtx: Context, tools: AgentToolSurface, sessionId: string): () => void {
  const register: Register = definition => agentCtx.tools.register(definition)
  const disposers: Array<() => void> = []
  try {
    disposers.push(unwrapDisposer(register({
      name: 'taskflow_submit_evidence',
      description:
        '提交子任务完成证明。证据三要素缺一不可：changesSummary（本轮做了什么、改了哪里）、'
        + 'verification（≥1 条验证记录：label/output/passed，运行真实命令并粘贴输出）、'
        + 'selfCheck（与验收标准逐条等长对应：acceptanceId/verdict/note）。'
        + '校验失败会返回修正提示，修正后可重复调用。子任务完成前必须成功调用本工具。',
      parameters: {
        type: 'object',
        properties: {
          changesSummary: { type: 'string', description: '本轮变更摘要：做了什么、改了哪里。' },
          verification: {
            type: 'array',
            description: '验证记录列表（至少 1 条）。',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                label: { type: 'string', description: '验证命令或检查名，如 "pnpm test"。' },
                output: { type: 'string', description: '命令输出摘录（超长会被截断至 8KiB）。' },
                passed: { type: 'boolean', description: '该验证是否通过。' },
              },
              required: ['label', 'output', 'passed'],
            },
          },
          selfCheck: {
            type: 'array',
            description: '逐条对照验收标准的自检，必须与验收标准等长、acceptanceId 一一对应。',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                acceptanceId: { type: 'string', description: '对应的验收标准条目 id（ac_*）。' },
                verdict: { type: 'string', enum: [...VERDICT_ENUM], description: '自检结论。' },
                note: { type: 'string', description: '判定依据说明。' },
              },
              required: ['acceptanceId', 'verdict', 'note'],
            },
          },
          diffSummary: { type: 'string', description: '可选：diff 统计（+n −m 与涉及文件列表）。' },
        },
        required: ['changesSummary', 'verification', 'selfCheck'],
      },
      output: { schema: EVIDENCE_OUTPUT_SCHEMA, render: renderJson },
      async execute(rawArgs: unknown): Promise<{ accepted: true } | { accepted: false; correction: string }> {
        const args = rawArgs as {
          changesSummary: string
          verification: Array<{ label: string; output: string; passed: boolean }>
          selfCheck: Array<{ acceptanceId: string; verdict: 'pass' | 'partial' | 'fail'; note: string }>
          diffSummary?: string
        }
        return tools.submitEvidence(args)
      },
      presentCall: () => ({ card: 'generic', title: '提交完成证明', kind: 'other' }),
    })))

    disposers.push(unwrapDisposer(register({
      name: 'taskflow_report_blocker',
      description:
        '报告无法继续的阻碍（如缺少凭据、环境损坏、验收标准自相矛盾）。'
        + '调用后子任务转为受阻并等人工处理；仅在确实无法继续时使用。',
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: '阻碍的具体原因与已尝试的绕行。' },
        },
        required: ['reason'],
      },
      output: { schema: EVIDENCE_OUTPUT_SCHEMA, render: renderJson },
      async execute(rawArgs: unknown): Promise<{ accepted: true } | { accepted: false; correction: string }> {
        const { reason } = rawArgs as { reason: string }
        const result = await tools.reportBlocker(reason)
        return result.accepted ? { accepted: true } : { accepted: false, correction: 'blocker 未受理（会话/状态不匹配）' }
      },
      presentCall: () => ({ card: 'generic', title: '报告阻碍', kind: 'other' }),
    })))

    disposers.push(unwrapDisposer(register({
      name: 'taskflow_update_progress',
      description: '记录一条进度便签（不改变状态），供用户在看板上围观进展。',
      parameters: {
        type: 'object',
        properties: {
          note: { type: 'string', description: '一句话进度说明。' },
        },
        required: ['note'],
      },
      output: { schema: EVIDENCE_OUTPUT_SCHEMA, render: renderJson },
      async execute(rawArgs: unknown): Promise<{ accepted: true } | { accepted: false; correction: string }> {
        const { note } = rawArgs as { note: string }
        const result = await tools.updateProgress(note)
        return result.accepted ? { accepted: true } : { accepted: false, correction: 'progress 未受理（会话/状态不匹配）' }
      },
      presentCall: () => ({ card: 'generic', title: '进度便签', kind: 'read' }),
    })))
    void sessionId
  } catch (error) {
    for (const dispose of disposers.reverse()) dispose()
    throw error
  }
  let active = true
  return () => {
    if (!active) return
    active = false
    for (const dispose of disposers.reverse()) dispose()
  }
}

/** register 返回值可能是 undefined 或非函数（宿主版本漂移），统一成可调用 disposer。 */
function unwrapDisposer(result: unknown): () => void {
  return typeof result === 'function' ? (result as () => void) : () => undefined
}
