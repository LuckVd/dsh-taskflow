/**
 * 浏览器通知（FR-16）：快照 diff 触发、基线不轰炸、偏好开关、点击聚焦管线。
 * jsdom 无 Notification —— 注入 mock 类到 globalThis 再装载模块逻辑。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { EngineState } from '../../src/protocol/types.ts'
import type { TaskflowTransport } from '../../src/client/api.ts'

interface FiredNotification {
  title: string
  body: string
  tag: string
  onclick: (() => void) | null
  closed: boolean
}

class MockNotification {
  static permission = 'default'
  static requestPermissionImpl: () => Promise<string> = async () => 'granted'
  static fired: FiredNotification[] = []
  static instances: MockNotification[] = []
  onclick: (() => void) | null = null
  constructor(title: string, options: { body?: string; tag?: string }) {
    MockNotification.instances.push(this)
    MockNotification.fired.push({ title, body: options.body ?? '', tag: options.tag ?? '', onclick: null, closed: false })
  }
  close(): void {}
  static async requestPermission(): Promise<string> {
    return MockNotification.requestPermissionImpl()
  }
}

/** 可编程 mock transport：手动推进快照与订阅者。 */
function mockTransport(): { transport: TaskflowTransport; push: (state: EngineState | null) => void } {
  let latest: EngineState | null = null
  const listeners: Array<() => void> = []
  return {
    transport: {
      getState: async () => {
        if (latest === null) throw new Error('no state')
        return latest
      },
      getCachedState: () => latest,
      dispatch: async () => {
        throw new Error('unused')
      },
      subscribe: (onChange: () => void) => {
        listeners.push(onChange)
        return () => undefined
      },
      getSettings: async () => {
        throw new Error('unused')
      },
      saveSettings: async () => {
        throw new Error('unused')
      },
      getModels: async () => {
        throw new Error('unused')
      },
      getArtifactPreview: async () => {
        throw new Error('unused')
      },
    },
    push: state => {
      latest = state
      for (const listener of [...listeners]) listener()
    },
  }
}

function stateOf(tasks: EngineState['ledger']['tasks']): EngineState {
  return { ledger: { schemaVersion: 1, revision: 1, tasks }, health: { corrupt: null, lastWriteFailed: false } }
}

/** 最小任务形状（notifications 只读 status/title/approvals/subtasks）。 */
function taskOf(overrides: Record<string, unknown>): never {
  return {
    id: 'tf_1',
    title: '任务一',
    status: 'in-progress',
    approvals: [],
    subtasks: [{ id: 's1', title: '子任务一' }],
    ...overrides,
  } as never
}

describe('浏览器通知（FR-16）', () => {
  beforeEach(() => {
    ;(globalThis as Record<string, unknown>).Notification = MockNotification
    MockNotification.fired = []
    MockNotification.instances = []
    MockNotification.permission = 'granted'
    MockNotification.requestPermissionImpl = async () => 'granted'
  })
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).Notification
  })

  it('新进待验收 → 系统通知；首帧基线不轰炸；打回再进不再漏发', async () => {
    const { installBrowserNotifications, setBrowserNotifyPref } = await import('../../src/client/notifications.ts')
    setBrowserNotifyPref(true)
    const { transport, push } = mockTransport()
    const opened: Array<{ taskId: string; approvalId?: string }> = []
    installBrowserNotifications(transport, focus => opened.push(focus))

    push(stateOf([taskOf({ status: 'review' })])) // 首帧：基线，不发
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(MockNotification.fired).toHaveLength(0)

    push(stateOf([taskOf({ status: 'review' }), taskOf({ id: 'tf_2', title: '任务二', status: 'review', approvals: [], subtasks: [] })]))
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(MockNotification.fired).toHaveLength(1)
    expect(MockNotification.fired[0]!.title).toContain('任务二')

    // 点击通知 → 聚焦管线带上任务 id
    MockNotification.instances[0]!.onclick?.()
    expect(opened).toEqual([{ taskId: 'tf_2' }])
  })

  it('新发起提权审批 → 通知带 approvalId 聚焦', async () => {
    const { installBrowserNotifications, setBrowserNotifyPref } = await import('../../src/client/notifications.ts')
    setBrowserNotifyPref(true)
    const { transport, push } = mockTransport()
    const opened: Array<{ taskId: string; approvalId?: string }> = []
    installBrowserNotifications(transport, focus => opened.push(focus))

    push(stateOf([taskOf({})]))
    await new Promise(resolve => setTimeout(resolve, 5))
    push(stateOf([
      taskOf({
        approvals: [{ id: 'ap_1', subtaskId: 's1', sessionId: 'sess-1', toolName: 'write', status: 'pending', createdAt: 1 }],
      }),
    ]))
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(MockNotification.fired).toHaveLength(1)
    expect(MockNotification.fired[0]!.title).toContain('write')
    MockNotification.instances[0]!.onclick?.()
    expect(opened).toEqual([{ taskId: 'tf_1', approvalId: 'ap_1' }])
  })

  it('偏好关闭时不发（角标/通知栏仍是兜底）；权限 denied 同样不发', async () => {
    const { installBrowserNotifications, setBrowserNotifyPref } = await import('../../src/client/notifications.ts')
    setBrowserNotifyPref(false)
    const { transport, push } = mockTransport()
    installBrowserNotifications(transport, () => undefined)
    push(stateOf([taskOf({})]))
    await new Promise(resolve => setTimeout(resolve, 5))
    push(stateOf([taskOf({ status: 'review' })]))
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(MockNotification.fired).toHaveLength(0)

    setBrowserNotifyPref(true)
    MockNotification.permission = 'denied'
    push(stateOf([taskOf({ id: 'tf_3', title: '任务三', status: 'in-progress', approvals: [], subtasks: [] })]))
    await new Promise(resolve => setTimeout(resolve, 5))
    push(stateOf([taskOf({ id: 'tf_3', title: '任务三', status: 'review', approvals: [], subtasks: [] })]))
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(MockNotification.fired).toHaveLength(0)
  })
})
