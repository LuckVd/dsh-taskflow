/**
 * 看板聚焦的模块级共享状态（与看板开合同套路）：全局通知栏「去处理」→
 * 打开看板并定位到指定任务的审批卡。纯模块状态，零宿主依赖，测试安全。
 *
 * @module dsh-taskflow/client
 */

export interface BoardFocus {
  taskId: string
  approvalId?: string
  /** 递增序号：同一任务重复聚焦也能触发订阅方。 */
  seq: number
}

let focus: BoardFocus | null = null
const listeners = new Set<() => void>()

export function setBoardFocus(target: { taskId: string; approvalId?: string }): void {
  focus = { ...target, seq: (focus?.seq ?? 0) + 1 }
  for (const listener of listeners) listener()
}

export function clearBoardFocus(): void {
  if (focus === null) return
  focus = null
  for (const listener of listeners) listener()
}

export function getBoardFocus(): BoardFocus | null {
  return focus
}

export function subscribeBoardFocus(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
