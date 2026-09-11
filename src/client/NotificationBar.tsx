/**
 * 全局通知栏（body 级，z-index 95）：待裁决审批的常驻通知条目。
 *
 * - 数据源：既有 SSE 全量快照 diff（引擎落库 pending 审批即出现，裁决即消失）；
 * - 容器 click-through、条目自管 pointer-events（shell.overlay 官方哲学）；
 * - 「去处理」→ onOpen()（打开看板）+ setBoardFocus（定位任务抽屉的审批卡）。
 *
 * @module dsh-taskflow/client
 */

import { useCallback, useEffect, useState } from 'react'
import type { TaskflowTransport } from './api.ts'
import { pendingApprovalsOf, relativeTime } from './view.ts'
import { setBoardFocus } from './focus.ts'
import type { EngineState } from '../protocol/types.ts'

export function NotificationBar({
  transport,
  onOpen,
}: {
  transport: TaskflowTransport
  onOpen: () => void
}): JSX.Element {
  const [state, setState] = useState<EngineState | null>(null)
  const refresh = useCallback(async () => {
    try {
      setState(await transport.getState())
    } catch {
      // 断线保留旧视图（SSE 重连后自动恢复）
    }
  }, [transport])
  useEffect(() => {
    void refresh()
    let unsubscribe: (() => void) | undefined
    try {
      unsubscribe = transport.subscribe(() => {
        void refresh()
      })
    } catch {
      // 订阅不可用：仅剩手动刷新语义，不挂不崩
    }
    return () => {
      unsubscribe?.()
    }
  }, [transport, refresh])

  const entries = (state?.ledger.tasks ?? [])
    .flatMap(task => pendingApprovalsOf(task))
    .sort((a, b) => a.createdAt - b.createdAt)
  if (entries.length === 0) return <></>
  return (
    <div className="tf-notify-stack" role="status" aria-label="全局通知：等待权限审批">
      {entries.map(approval => (
        <div className="tf-notify" key={approval.id}>
          <span className="tf-notify-dot" aria-hidden="true" />
          <span className="tf-notify-body">
            <span className="tf-notify-title">等待权限审批 · {approval.toolName}</span>
            <span className="tf-notify-desc">「{approval.subtaskTitle}」 · {relativeTime(approval.createdAt)}</span>
          </span>
          <button
            type="button"
            className="tf-btn tf-btn-primary tf-notify-go"
            onClick={() => {
              setBoardFocus({ taskId: approval.taskId, approvalId: approval.id })
              onOpen()
            }}
          >
            去处理
          </button>
        </div>
      ))}
    </div>
  )
}
