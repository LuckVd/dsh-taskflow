import { describe, expect, it } from 'vitest'
import { ActionFormatError, validateActionShape } from '../../src/protocol/actions.ts'
import { DecomposeValidationError, validateDecomposeOutput } from '../../src/protocol/decompose.ts'
import { EvidenceRejectedError, normalizeEvidence, parseEvidenceInput, renderEvidenceCorrection } from '../../src/protocol/evidence.ts'

describe('action 白名单与形状校验（§6）', () => {
  const base = { type: 'createTask', requestId: 'r1', title: '标题', description: '描述' }

  it('接受合法 createTask 并透传字段', () => {
    const action = validateActionShape({ ...base, acceptance: [{ text: '验收 1' }], pins: { permission: 'workspace-write' }, maxRounds: 5 })
    expect(action).toMatchObject({ type: 'createTask', requestId: 'r1', maxRounds: 5 })
  })

  it('拒绝未知 action 类型（白名单封闭）', () => {
    expect(() => validateActionShape({ ...base, type: 'rm -rf /' })).toThrow(ActionFormatError)
    expect(() => validateActionShape({ ...base, type: 'runCommand' })).toThrow(/unknown action type/)
  })

  it('拒绝非绝对路径的 workspace', () => {
    expect(() => validateActionShape({ ...base, pins: { workspace: 'relative/path' } })).toThrow(/absolute path/)
    expect(() => validateActionShape({ ...base, pins: { workspace: '/abs/path' } })).not.toThrow()
  })

  it('pins 白名单外字段拒绝（无命令/可执行路径字段）', () => {
    expect(() => validateActionShape({ ...base, pins: { command: 'ls' } })).toThrow(/not allowed/)
    expect(() => validateActionShape({ ...base, pins: { shell: 'bash -c x' } })).toThrow(/not allowed/)
  })

  it('标题 120 字上限；空标题/空描述拒绝', () => {
    expect(() => validateActionShape({ ...base, title: 'x'.repeat(121) })).toThrow(/120/)
    expect(() => validateActionShape({ ...base, title: '  ' })).toThrow(/non-empty/)
    expect(() => validateActionShape({ ...base, description: '' })).toThrow(/non-empty/)
  })

  it('cancelTask 必须携带 confirm:true（二次确认）', () => {
    expect(() => validateActionShape({ type: 'cancelTask', requestId: 'r', taskId: 'tf_1' })).toThrow(/confirm/)
    expect(validateActionShape({ type: 'cancelTask', requestId: 'r', taskId: 'tf_1', confirm: true })).toMatchObject({ type: 'cancelTask' })
  })

  it('rejectSubtask 批语必填；subtaskIds 非空数组', () => {
    const base2 = { type: 'rejectSubtask', requestId: 'r', taskId: 'tf_1' }
    expect(() => validateActionShape({ ...base2, comment: '' })).toThrow(/non-empty/)
    expect(() => validateActionShape({ ...base2, comment: '批语', subtaskIds: [] })).toThrow(/not be empty/)
    expect(validateActionShape({ ...base2, comment: '批语' })).toMatchObject({ comment: '批语' })
  })

  it('maxRounds 范围 [1,99] 或 null', () => {
    expect(() => validateActionShape({ ...base, maxRounds: 0 })).toThrow(/maxRounds/)
    expect(() => validateActionShape({ ...base, maxRounds: 100 })).toThrow(/maxRounds/)
    expect(validateActionShape({ ...base, maxRounds: null })).toMatchObject({ maxRounds: null })
  })

  it('editSubtasks 至少一项操作；acceptance 非空', () => {
    const base3 = { type: 'editSubtasks', requestId: 'r', taskId: 'tf_1' }
    expect(() => validateActionShape(base3)).toThrow(/at least one/)
    expect(() => validateActionShape({ ...base3, add: [{ title: 't', detail: '', acceptance: [] }] })).toThrow(/acceptance/)
    expect(
      validateActionShape({ ...base3, add: [{ title: 't', detail: '', acceptance: [{ text: 'a' }] }] }),
    ).toMatchObject({ type: 'editSubtasks' })
  })
})

describe('拆解产物 schema 校验（§4.3）', () => {
  const valid = {
    taskAcceptance: [{ text: '验收 1' }],
    subtasks: [
      { title: 'A', detail: 'da', acceptance: [{ text: 'a1' }], deps: [] },
      { title: 'B', detail: 'db', acceptance: [{ text: 'b1' }], deps: ['A'] },
    ],
  }

  it('合法产物通过并规范化 deps 为索引引用', () => {
    const out = validateDecomposeOutput(valid)
    expect(out.subtasks[1]!.deps).toEqual(['s1'])
  })

  it('拒绝：空子任务/空子任务验收/空任务级验收', () => {
    expect(() => validateDecomposeOutput({ ...valid, subtasks: [] })).toThrow(DecomposeValidationError)
    expect(() => validateDecomposeOutput({ ...valid, subtasks: [{ ...valid.subtasks[0], acceptance: [] }] })).toThrow(DecomposeValidationError)
    expect(() => validateDecomposeOutput({ ...valid, taskAcceptance: [] })).toThrow(DecomposeValidationError)
  })

  it('拒绝：依赖环', () => {
    const cyclic = {
      taskAcceptance: [{ text: 'x' }],
      subtasks: [
        { title: 'A', detail: '', acceptance: [{ text: '1' }], deps: ['B'] },
        { title: 'B', detail: '', acceptance: [{ text: '2' }], deps: ['A'] },
      ],
    }
    expect(() => validateDecomposeOutput(cyclic)).toThrow(/cycle/)
  })

  it('拒绝：未知依赖引用', () => {
    const unknown = {
      taskAcceptance: [{ text: 'x' }],
      subtasks: [{ title: 'A', detail: '', acceptance: [{ text: '1' }], deps: ['NOPE'] }],
    }
    expect(() => validateDecomposeOutput(unknown)).toThrow(/unknown/)
  })

  it('拒绝：标题重复 / 超过 20 个子任务', () => {
    expect(() =>
      validateDecomposeOutput({
        taskAcceptance: [{ text: 'x' }],
        subtasks: [
          { title: 'A', detail: '', acceptance: [{ text: '1' }], deps: [] },
          { title: 'A', detail: '', acceptance: [{ text: '2' }], deps: [] },
        ],
      }),
    ).toThrow(/duplicates/)
    const many = Array.from({ length: 21 }, (_, i) => ({ title: `T${i}`, detail: '', acceptance: [{ text: 'x' }], deps: [] }))
    expect(() => validateDecomposeOutput({ taskAcceptance: [{ text: 'x' }], subtasks: many })).toThrow(/20/)
  })
})

describe('Evidence 三要素校验（§4.5/§7.4 不变量 3）', () => {
  const acceptanceIds = ['ac_1', 'ac_2']

  it('三要素齐全 + selfCheck 等长对应 → 规范化通过', () => {
    const parsed = parseEvidenceInput({
      changesSummary: '做了 X',
      verification: [{ label: 'pnpm test', output: 'all pass', passed: true }],
      selfCheck: [
        { acceptanceId: 'ac_1', verdict: 'pass', note: 'ok' },
        { acceptanceId: 'ac_2', verdict: 'partial', note: 'half' },
      ],
    })
    const normalized = normalizeEvidence(parsed, acceptanceIds)
    expect(normalized.selfCheck).toHaveLength(2)
  })

  it('selfCheck 缺条拒收（不得跳条）', () => {
    const parsed = parseEvidenceInput({
      changesSummary: 'x',
      verification: [{ label: 'l', output: 'o', passed: true }],
      selfCheck: [{ acceptanceId: 'ac_1', verdict: 'pass', note: '' }],
    })
    expect(() => normalizeEvidence(parsed, acceptanceIds)).toThrow(EvidenceRejectedError)
  })

  it('selfCheck 引用不存在条目拒收；重复条目拒收', () => {
    const mk = (selfCheck: unknown) =>
      parseEvidenceInput({ changesSummary: 'x', verification: [{ label: 'l', output: 'o', passed: true }], selfCheck })
    expect(() => normalizeEvidence(mk([{ acceptanceId: 'ac_9', verdict: 'pass', note: '' }]), acceptanceIds)).toThrow(/不存在/)
    expect(() =>
      normalizeEvidence(
        mk([
          { acceptanceId: 'ac_1', verdict: 'pass', note: '' },
          { acceptanceId: 'ac_1', verdict: 'pass', note: '' },
        ]),
        acceptanceIds,
      ),
    ).toThrow(/重复/)
  })

  it('空 verification / 空 changesSummary 在形状层拒收', () => {
    expect(() => parseEvidenceInput({ changesSummary: 'x', verification: [], selfCheck: [] })).toThrow(/verification/)
    expect(() => parseEvidenceInput({ changesSummary: '', verification: [{ label: 'l', output: 'o', passed: true }], selfCheck: [] })).toThrow(
      /changesSummary/,
    )
  })

  it('验证输出截断至 8KiB（§7.4）', () => {
    const big = 'x'.repeat(9 * 1024)
    const parsed = parseEvidenceInput({
      changesSummary: 'x',
      verification: [{ label: 'l', output: big, passed: true }],
      selfCheck: [{ acceptanceId: 'ac_1', verdict: 'pass', note: '' }],
    })
    const normalized = normalizeEvidence(parsed, acceptanceIds.slice(0, 1))
    expect(Buffer.byteLength(normalized.verification[0]!.output, 'utf8')).toBeLessThanOrEqual(8 * 1024 + 64)
    expect(normalized.verification[0]!.output).toContain('截断至 8KiB')
  })

  it('修正提示可回给 agent（§8：不转状态）', () => {
    try {
      const parsed = parseEvidenceInput({
        changesSummary: 'x',
        verification: [{ label: 'l', output: 'o', passed: true }],
        selfCheck: [],
      })
      normalizeEvidence(parsed, acceptanceIds)
    } catch (error) {
      expect(error).toBeInstanceOf(EvidenceRejectedError)
      const hint = renderEvidenceCorrection(error as EvidenceRejectedError)
      expect(hint).toContain('submit_evidence 被拒收')
      expect(hint).toContain('ac_1')
    }
  })
})

describe('decideApproval 与 pins.executionMode 校验（§7.1b）', () => {
  const base = { type: 'decideApproval', requestId: 'da-1', taskId: 'tf_1', approvalId: 'ap_1' }

  it('接受合法 allow/reject，note 可选', () => {
    expect(() => validateActionShape({ ...base, decision: 'allow' })).not.toThrow()
    expect(() => validateActionShape({ ...base, decision: 'reject', note: '只允许读' })).not.toThrow()
    const action = validateActionShape({ ...base, decision: 'reject' })
    expect(action).toMatchObject({ type: 'decideApproval', decision: 'reject' })
  })

  it('decision 非法值与缺失 approvalId 拒绝', () => {
    expect(() => validateActionShape({ ...base, decision: 'allow-all' })).toThrow(ActionFormatError)
    expect(() => validateActionShape({ type: 'decideApproval', requestId: 'da-2', taskId: 'tf_1', decision: 'allow' })).toThrow(/approvalId/)
  })

  it('createTask/updateContract 的 pins 接受 executionMode', () => {
    expect(() => validateActionShape({ type: 'createTask', requestId: 'r2', title: 't', description: 'd', pins: { executionMode: 'approval' } })).not.toThrow()
    expect(() => validateActionShape({ type: 'createTask', requestId: 'r3', title: 't', description: 'd', pins: { executionMode: 'sudo' } })).toThrow(/executionMode/)
  })
})

describe('交付物声明校验（§4.5b：Evidence.artifacts）', () => {
  const acceptanceIds = ['ac_1']
  const base = {
    changesSummary: '产出报告',
    verification: [{ label: 'l', output: 'o', passed: true }],
    selfCheck: [{ acceptanceId: 'ac_1', verdict: 'pass' as const, note: '' }],
  }

  it('合法 artifacts 规范化保留（path trim + 字段截断）', () => {
    const parsed = parseEvidenceInput({
      ...base,
      artifacts: [{ path: ' /root/报告.md ', description: 'x'.repeat(600), howVerified: 'ls -l' }],
    })
    const normalized = normalizeEvidence(parsed, acceptanceIds)
    expect(normalized.artifacts).toEqual([{ path: '/root/报告.md', description: 'x'.repeat(500), howVerified: 'ls -l' }])
  })

  it('省略或空数组 artifacts → 规范化后为 undefined（旧证据形态不变）', () => {
    const without = normalizeEvidence(parseEvidenceInput(base), acceptanceIds)
    expect('artifacts' in without).toBe(false)
    const empty = normalizeEvidence(parseEvidenceInput({ ...base, artifacts: [] }), acceptanceIds)
    expect('artifacts' in empty).toBe(false)
  })

  it('非数组 / 缺 path / 空 path / 相对路径拒收', () => {
    expect(() => parseEvidenceInput({ ...base, artifacts: 'nope' })).toThrow(/artifacts/)
    expect(() => parseEvidenceInput({ ...base, artifacts: [{ description: 'no path' } as never] })).toThrow(/path/)
    expect(() => parseEvidenceInput({ ...base, artifacts: [{ path: '   ' }] })).toThrow(/path/)
    expect(() => parseEvidenceInput({ ...base, artifacts: [{ path: 'relative/report.md' }] })).toThrow(/绝对路径/)
  })

  it('超过 20 条拒收；description/howVerified 非字符串拒收', () => {
    const many = Array.from({ length: 21 }, (_, i) => ({ path: `/root/f${i}.md` }))
    expect(() => parseEvidenceInput({ ...base, artifacts: many })).toThrow(/at most 20/)
    // 边界内 20 条（真机任务多子报告交付可达 12 项）放行
    const edge = Array.from({ length: 20 }, (_, i) => ({ path: `/root/f${i}.md` }))
    expect(parseEvidenceInput({ ...base, artifacts: edge }).artifacts).toHaveLength(20)
    expect(() => parseEvidenceInput({ ...base, artifacts: [{ path: '/root/a.md', description: 3 as never }] })).toThrow(/description/)
    expect(() => parseEvidenceInput({ ...base, artifacts: [{ path: '/root/a.md', howVerified: true as never }] })).toThrow(/howVerified/)
  })

  it('终检/子任务证据之外的旧 ledger 无 artifacts 字段照常工作（加性变更）', () => {
    const evidence = normalizeEvidence(parseEvidenceInput(base), acceptanceIds)
    expect(Object.keys(evidence)).toEqual(expect.not.arrayContaining(['artifacts']))
    expect(evidence.changesSummary).toBe('产出报告')
  })
})
