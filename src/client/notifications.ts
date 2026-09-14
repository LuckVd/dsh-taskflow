/**
 * 可选浏览器通知（FR-16 / US-15）：任务新进待验收、新发起提权审批时发系统通知。
 *
 * - shell 级常驻（看板关着也要能响——「不用反复刷页面」是本条需求的存在理由）；
 * - 数据源与通知栏同款：SSE 快照 diff（新出现的 review 任务 / pending 审批）；
 *   首个快照只建基线（页面刚打开就已在等的东西靠角标/通知栏呈现，不轰炸）；
 * - 用户opt-in：偏好存 localStorage（'taskflow.browserNotify'），开关在看板工具栏
 *   （🔔），开启时按需请求 Notification 权限；denied 后按钮给出提示；
 * - 点击通知 → window.focus() + 打开看板并定位对应任务（复用 setBoardFocus 管线）；
 * - 环境不支持 Notification（老浏览器/测试 jsdom 未注入）→ 功能整体退化为无操作，
 *   看板工具栏不渲染开关。
 *
 * @module dsh-taskflow/client
 */

import type { TaskflowTransport } from './api.ts'
import { pendingApprovalsOf } from './view.ts'
import type { EngineState, Task } from '../protocol/types.ts'

const PREF_KEY = 'taskflow.browserNotify'

/** 环境是否支持浏览器通知（不支持则工具栏不渲染开关、watcher 退化为无操作）。 */
export function browserNotifySupported(): boolean {
  return typeof Notification !== 'undefined'
}

/** localStorage 不可用（隐私模式等）时的内存回退。 */
let memoryPref: boolean | null = null

function readStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

/** 用户偏好（localStorage 优先；缺省关）。 */
export function browserNotifyPref(): boolean {
  const storage = readStorage()
  if (storage !== null) return storage.getItem(PREF_KEY) === '1'
  return memoryPref === true
}

export function setBrowserNotifyPref(enabled: boolean): void {
  const storage = readStorage()
  if (storage !== null) storage.setItem(PREF_KEY, enabled ? '1' : '0')
  else memoryPref = enabled
}

/** 当前权限态（'granted' | 'denied' | 'default'；不支持环境返回 'unsupported'）。 */
export function browserNotifyPermission(): string {
  if (!browserNotifySupported()) return 'unsupported'
  return Notification.permission
}

/** 请求权限（点开关时调用）；返回最终权限态。 */
export async function requestBrowserNotifyPermission(): Promise<string> {
  if (!browserNotifySupported()) return 'unsupported'
  try {
    return await Notification.requestPermission()
  } catch {
    return 'denied'
  }
}

interface NotifyTarget {
  taskId: string
  approvalId?: string
}

function fireNotification(title: string, body: string, target: NotifyTarget, openBoard: (focus: NotifyTarget) => void): void {
  try {
    const notification = new Notification(title, { body, tag: `taskflow:${target.approvalId ?? target.taskId}` })
    notification.onclick = () => {
      globalThis.focus?.()
      openBoard(target)
      notification.close()
    }
  } catch {
    // 构造失败（个别环境对 options 敏感）：静默，角标仍是兜底
  }
}

/**
 * 安装快照监听（幂等语义由调用方保证；返回卸载函数）。
 * `openBoard` 收到应聚焦的任务/审批（shell 注入 setBoardFocus + setBoardOpen）。
 */
export function installBrowserNotifications(
  transport: TaskflowTransport,
  openBoard: (focus: NotifyTarget) => void,
): () => void {
  if (!browserNotifySupported()) return () => undefined

  let reviewIds = new Set<string>()
  let approvalIds = new Set<string>()
  let baselined = false

  const onSnapshot = (state: EngineState | null): void => {
    if (state === null) return
    const tasks: Task[] = state.ledger.tasks
    const nextReview = new Set(tasks.filter(t => t.status === 'review').map(t => t.id))
    const nextApprovals = new Set(tasks.flatMap(t => pendingApprovalsOf(t).map(a => a.id)))
    if (!baselined) {
      baselined = true
      reviewIds = nextReview
      approvalIds = nextApprovals
      return
    }
    if (!browserNotifyPref() || browserNotifyPermission() !== 'granted') {
      reviewIds = nextReview
      approvalIds = nextApprovals
      return
    }
    for (const task of tasks) {
      if (task.status === 'review' && !reviewIds.has(task.id)) {
        fireNotification(`任务待验收：${task.title}`, '证据已齐备，等你终批（通过 / 打回）', { taskId: task.id }, openBoard)
      }
      for (const approval of pendingApprovalsOf(task)) {
        if (!approvalIds.has(approval.id)) {
          fireNotification(
            `等待权限审批：${approval.toolName}`,
            `子任务「${approval.subtaskTitle}」的提权请求等你裁决`,
            { taskId: task.id, approvalId: approval.id },
            openBoard,
          )
        }
      }
    }
    reviewIds = nextReview
    approvalIds = nextApprovals
  }

  // 首帧基线：transport 缓存可能已有快照（页面加载即建基线，不补发历史通知）
  const cached = transport.getCachedState()
  if (cached !== null) onSnapshot(cached)

  let unsubscribe: (() => void) | undefined
  try {
    unsubscribe = transport.subscribe(() => {
      // 与通知栏同款：订阅回调里拉新快照（单飞合并；同步读缓存会滞后一拍，
      // 静默前的最后一个事件将永远发不出通知）
      void transport
        .getState()
        .then(onSnapshot)
        .catch(() => undefined)
    })
  } catch {
    // 订阅不可用：仅剩首帧基线，无后续通知
  }
  return () => {
    unsubscribe?.()
  }
}
