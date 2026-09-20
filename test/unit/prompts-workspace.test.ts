/**
 * FR-21 工作区域钉定：提示词工作区域条款（有/无 pins.workspace 两分支）。
 *
 * @module dsh-taskflow/test
 */
import { describe, expect, it } from 'vitest'
import { renderDecomposePrompt, renderExecutionPrompt, renderFinalCheckPrompt } from '../../src/host/prompts.ts'
import type { Subtask, Task } from '../../src/protocol/types.ts'

function makeTask(workspace: string): Task {
  return {
    id: 'tf_test',
    title: '示例任务',
    description: '示例描述',
    contract: {
      objective: '目标',
      acceptance: [{ id: 'ac_1', text: '测试通过' }],
      sourceOfAcceptance: 'human',
      pins: { workspace, presetId: null, permission: 'workspace-write' },
    },
    status: 'ready',
    subtasks: [],
    events: [],
    round: 1,
    maxRounds: null,
    createdAt: 0,
    updatedAt: 0,
    createdBy: 'human',
    autoStart: true,
    permissionConfirmed: true,
    decomposeSessionIds: [],
  }
}

function makeSubtask(): Subtask {
  return {
    id: 'st_1',
    title: '子任务一',
    detail: '实现它',
    status: 'in-progress',
    acceptance: [{ id: 'ac_s1', text: '子任务完成' }],
    deps: [],
    round: 1,
    history: [],
    sessionId: null,
  } as unknown as Subtask
}

describe('FR-21 工作区域条款', () => {
  const ws = '/opt/pro/dsh-taskflow'
  it('指定 workspace：拆解/执行/终检提示词均注入工作区域条款', () => {
    const task = makeTask(ws)
    for (const prompt of [
      renderDecomposePrompt(task),
      renderExecutionPrompt(task, makeSubtask()),
      renderFinalCheckPrompt(task),
    ]) {
      expect(prompt).toContain(`工作区域：${ws}`)
      expect(prompt).toContain('只能发生在该区域内')
    }
  })

  it('未指定 workspace（默认工作区）：不注入条款', () => {
    const task = makeTask('')
    for (const prompt of [
      renderDecomposePrompt(task),
      renderExecutionPrompt(task, makeSubtask()),
      renderFinalCheckPrompt(task),
    ]) {
      expect(prompt).not.toContain('工作区域：')
    }
  })
})
