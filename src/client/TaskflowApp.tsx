/**
 * 看板主组件（FR-10/11，US-14 三态完整）。
 *
 * @module dsh-taskflow/client
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import type { TaskflowTransport } from './api.ts'
import {
  actorLabel,
  boardGroups,
  dagLayout,
  dagPhases,
  decimalOf,
  filterTasks,
  formatBytes,
  modelForSession,
  pendingApprovalCount,
  pendingApprovalsOf,
  percentOf,
  phaseTimeline,
  progressRatio,
  relativeTime,
  reportStats,
  reviewBadgeCount,
  shortArtifactPath,
  statusLabel,
  subtaskStatusLabel,
  subtaskTimeline,
  subtaskWait,
  truncateForDag,
} from './view.ts'
import type { CardSummary, DagNode, DagPhase, DagPhaseId, PendingApprovalView, TimelineEntry } from './view.ts'
import { clearBoardFocus, getBoardFocus, subscribeBoardFocus } from './focus.ts'
import { ModelSettingsPopover } from './ModelSettingsPopover.tsx'
import {
  browserNotifyPermission,
  browserNotifyPref,
  browserNotifySupported,
  requestBrowserNotifyPermission,
  setBrowserNotifyPref,
} from './notifications.ts'
import { parseMarkdown } from './markdown.ts'
import { renderBlocks } from './MarkdownView.tsx'
import type { Artifact, ArtifactPreview, DispatchResult, EngineState, GlobalSettings, ModelCatalog } from '../protocol/types.ts'
import { CAPABILITIES } from '../protocol/types.ts'
import type { AcceptanceItem, Evidence, Subtask, Task } from '../protocol/types.ts'

type TabId = 'contract' | 'flow' | 'subtasks' | 'review' | 'deliverables' | 'decompose'

const TABS: ReadonlyArray<{ id: TabId; title: string }> = [
  { id: 'contract', title: '合同' },
  { id: 'flow', title: '流程' },
  { id: 'subtasks', title: '子任务' },
  { id: 'review', title: '验收' },
  { id: 'deliverables', title: '产物' },
  { id: 'decompose', title: '拆解记录' },
]

function newRequestId(): string {
  return `ui-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export function TaskflowApp({ transport, onClose }: { transport: TaskflowTransport; onClose?: () => void }): JSX.Element {
  // 秒开：共享传输已有缓存（页面加载时通知栏拉过）就直接首屏渲染，再后台对账；
  // 真正冷启动（首次打开且无任何缓存）才走骨架屏。
  const [state, setState] = useState<EngineState | null>(() => transport.getCachedState())
  const [loadError, setLoadError] = useState<string | null>(null)
  const [sseUp, setSseUp] = useState(true)
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'review' | 'blocked' | 'done'>('all')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [focusApprovalId, setFocusApprovalId] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  /** 统计浮层（FR-20）：只读投影，无持久化。 */
  const [statsOpen, setStatsOpen] = useState(false)
  // 浏览器通知开关（FR-16）：偏好/权限是外部状态，本地存一份镜像驱动重渲染
  const [notifyOn, setNotifyOn] = useState(() => browserNotifyPref() && browserNotifyPermission() === 'granted')
  const [notifyDenied, setNotifyDenied] = useState(() => browserNotifyPermission() === 'denied')
  // 批量操作（2026-09-12 归档 → 2026-09-15 FR-14 扩展批量验收）：选择模式 +
  // 勾选（待验收 / 可归档状态）+ 二次确认后逐个 dispatch（复用单任务守卫与留痕）
  const [batchMode, setBatchMode] = useState(false)
  const [batchSelected, setBatchSelected] = useState<Record<string, boolean>>({})
  const [batchBusy, setBatchBusy] = useState(false)
  /** 待确认的动作（null = 未在确认步）：archive / approve / reject。 */
  const [batchConfirm, setBatchConfirm] = useState<'archive' | 'approve' | 'reject' | null>(null)
  /** 批量打回的共用批语（US-07：打回强制批语，注入每个任务的下一轮迭代）。 */
  const [batchComment, setBatchComment] = useState('')
  const refreshSeq = useRef(0)
  // 全局通知栏「去处理」→ 打开对应任务的抽屉并高亮审批卡（focus.ts 模块级存储）
  const focus = useSyncExternalStore(subscribeBoardFocus, getBoardFocus)
  useEffect(() => {
    if (focus === null) return
    setSelectedId(focus.taskId)
    setFocusApprovalId(focus.approvalId ?? null)
    clearBoardFocus()
  }, [focus])

  const refresh = useCallback(async () => {
    refreshSeq.current += 1
    try {
      const next = await transport.getState()
      setState(next)
      setLoadError(null)
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error))
    }
  }, [transport])

  useEffect(() => {
    void refresh()
    const unsubscribe = transport.subscribe(() => {
      setSseUp(true)
      void refresh()
    })
    return unsubscribe
  }, [transport, refresh])

  const dispatch = useCallback(
    async (action: Record<string, unknown>): Promise<DispatchResult> => {
      const result = await transport.dispatch({ requestId: newRequestId(), ...action } as never)
      void refresh()
      return result
    },
    [transport, refresh],
  )

  /** 批量归档（2026-09-12）：客户端循环 dispatch archiveTask（引擎无批量 action，
   *  复用单任务守卫与留痕；一次 refresh 汇总）。2026-09-15 起只作用于可归档子集。 */
  const archiveMany = useCallback(async (ids: string[]): Promise<void> => {
    if (ids.length === 0) return
    setBatchBusy(true)
    const results = await Promise.all(ids.map(id => dispatch({ type: 'archiveTask', taskId: id } as never)))
    setBatchBusy(false)
    setBatchConfirm(null)
    setBatchMode(false)
    setBatchSelected({})
    void refresh()
    const failed = results.filter(r => !r.ok).length
    if (failed > 0) setLoadError(`${failed} 项归档失败（其余已归档）。`)
  }, [dispatch, refresh])

  /** 批量通过（FR-14）：review 任务逐个 approveTask（任务级终批 → done）。 */
  const approveMany = useCallback(async (ids: string[]): Promise<void> => {
    if (ids.length === 0) return
    setBatchBusy(true)
    const results = await Promise.all(ids.map(id => dispatch({ type: 'approveTask', taskId: id } as never)))
    setBatchBusy(false)
    setBatchConfirm(null)
    setBatchMode(false)
    setBatchSelected({})
    void refresh()
    const failed = results.filter(r => !r.ok).length
    if (failed > 0) setLoadError(`${failed} 项通过失败（其余已通过）。`)
  }, [dispatch, refresh])

  /** 批量打回（FR-14）：共用批语逐个 rejectSubtask（不点名范围，走 AI triage 定位返工）。 */
  const rejectMany = useCallback(async (ids: string[], comment: string): Promise<void> => {
    if (ids.length === 0 || comment.trim().length === 0) return
    setBatchBusy(true)
    const results = await Promise.all(ids.map(id => dispatch({ type: 'rejectSubtask', taskId: id, comment } as never)))
    setBatchBusy(false)
    setBatchConfirm(null)
    setBatchComment('')
    setBatchMode(false)
    setBatchSelected({})
    void refresh()
    const failed = results.filter(r => !r.ok).length
    if (failed > 0) setLoadError(`${failed} 项打回失败（其余已打回）。`)
  }, [dispatch, refresh])

  const batchCount = Object.values(batchSelected).filter(Boolean).length

  const tasks = state?.ledger.tasks ?? []
  const filtered = useMemo(() => filterTasks(tasks, { query, status: statusFilter }), [tasks, query, statusFilter])
  const groups = useMemo(() => boardGroups(filtered), [filtered])
  const reviewCount = reviewBadgeCount(tasks)
  const approvalCount = pendingApprovalCount(tasks)
  const selected = tasks.find(t => t.id === selectedId) ?? null
  // 按当前账本状态划分选择集（动作只作用于各自可用子集；状态在批量期间可能已变化）
  const selectedReviewIds = tasks.filter(t => batchSelected[t.id] === true && t.status === 'review').map(t => t.id)
  const selectedArchivableIds = tasks.filter(t => batchSelected[t.id] === true && isArchivable(t.status)).map(t => t.id)

  return (
    <div className="tf-root tf-board" role="application" aria-label="taskflow 看板">
      {loadError !== null && (
        <div className="tf-banner" role="alert">
          <span>加载失败：{loadError}</span>
          <button type="button" className="tf-btn" onClick={() => void refresh()}>重试</button>
        </div>
      )}
      {state !== null && state.health.corrupt !== null && (
        <div className="tf-banner" role="alert">
          ledger 损坏，已移入 {state.health.corrupt.movedTo} 保留原始字节；当前以空账本启动。
        </div>
      )}
      <div className="tf-toolbar">
        <span className="tf-title">任务看板</span>
        <label className="tf-search">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <circle cx="11" cy="11" r="6.5" />
            <path d="M16 16l4.5 4.5" />
          </svg>
          <input
            type="search"
            placeholder="搜索标题 / 描述 / 子任务"
            value={query}
            onChange={event => setQuery(event.target.value)}
            aria-label="搜索任务"
          />
        </label>
        <select className="tf-select" value={statusFilter} onChange={event => setStatusFilter(event.target.value as typeof statusFilter)} aria-label="状态过滤">
          <option value="all">全部状态</option>
          <option value="active">进行中</option>
          <option value="review">待验收</option>
          <option value="blocked">受阻</option>
          <option value="done">已完成</option>
        </select>
        <span className="tf-badge tf-badge-review" role="status" aria-label="待验收数量">
          <i aria-hidden="true" />
          待验收 {reviewCount}
        </span>
        {approvalCount > 0 && (
          <span className="tf-badge tf-badge-approval" role="status" aria-label="待审批数量">
            <i aria-hidden="true" />
            待审批 {approvalCount}
          </span>
        )}
        {browserNotifySupported() && (
          <button
            type="button"
            className={`tf-icon-btn${notifyOn ? ' tf-notify-on' : ''}`}
            aria-pressed={notifyOn}
            aria-label={notifyOn ? '关闭浏览器通知' : '开启浏览器通知'}
            title={notifyDenied ? '浏览器通知权限已被拒绝，请在浏览器设置中恢复' : notifyOn ? '浏览器通知已开启' : '待验收/待审批时发浏览器通知（点击开启）'}
            onClick={() => void (async () => {
              if (notifyOn) {
                setBrowserNotifyPref(false)
                setNotifyOn(false)
                return
              }
              const permission = browserNotifyPermission() === 'granted' ? 'granted' : await requestBrowserNotifyPermission()
              if (permission !== 'granted') {
                setNotifyDenied(permission === 'denied')
                return
              }
              setBrowserNotifyPref(true)
              setNotifyOn(true)
              setNotifyDenied(false)
            })()}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
              <path d="M13.73 21a2 2 0 0 1-3.46 0" />
            </svg>
          </button>
        )}
        <span className="tf-settings-anchor">
          <button
            type="button"
            className={`tf-icon-btn${statsOpen ? ' tf-notify-on' : ''}`}
            aria-label="周期统计"
            aria-expanded={statsOpen}
            title="周期统计（吞吐 / 一次通过率 / 迭代轮次）"
            onClick={() => setStatsOpen(open => !open)}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M3 3v18h18" />
              <path d="M7 15v-4" />
              <path d="M12 15V7" />
              <path d="M17 15v-7" />
            </svg>
          </button>
          {statsOpen && <StatsPopover tasks={tasks} onClose={() => setStatsOpen(false)} />}
        </span>
        <span className="tf-settings-anchor">
          <button
            type="button"
            className="tf-icon-btn"
            aria-label="全局设置"
            aria-expanded={settingsOpen}
            title="全局设置"
            onClick={() => setSettingsOpen(open => !open)}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
            </svg>
          </button>
          {settingsOpen && <ModelSettingsPopover transport={transport} onClose={() => setSettingsOpen(false)} />}
        </span>
        <button type="button" className={`tf-btn${batchMode ? ' tf-btn-primary' : ''}`} aria-pressed={batchMode} onClick={() => setBatchMode(mode => !mode)}>
          {batchMode ? '退出批量' : '批量操作'}
        </button>
        <button type="button" className="tf-btn tf-btn-primary" onClick={() => setCreateOpen(true)}>+ 新建任务</button>
        {batchMode && (
          <span className="tf-batchbar" role="region" aria-label="批量操作">
            <span className="count">已选 {batchCount} 项{selectedReviewIds.length + selectedArchivableIds.length !== batchCount ? '（含状态已变化项，按可用动作执行）' : ''}</span>
            {batchConfirm === 'archive' ? (
              <>
                <span>归档后不可恢复，确认归档 {selectedArchivableIds.length} 项？</span>
                <button type="button" className="tf-btn tf-btn-primary" disabled={batchBusy || selectedArchivableIds.length === 0} onClick={() => void archiveMany(selectedArchivableIds)}>{batchBusy ? '归档中…' : '确认归档'}</button>
                <button type="button" className="tf-btn" disabled={batchBusy} onClick={() => setBatchConfirm(null)}>再想想</button>
              </>
            ) : batchConfirm === 'approve' ? (
              <>
                <span>通过即完成验收（done），确认通过 {selectedReviewIds.length} 项？</span>
                <button type="button" className="tf-btn tf-btn-primary" disabled={batchBusy || selectedReviewIds.length === 0} onClick={() => void approveMany(selectedReviewIds)}>{batchBusy ? '通过中…' : '确认通过'}</button>
                <button type="button" className="tf-btn" disabled={batchBusy} onClick={() => setBatchConfirm(null)}>再想想</button>
              </>
            ) : batchConfirm === 'reject' ? (
              <>
                <span>打回 {selectedReviewIds.length} 项，批语将注入各自的下一轮迭代：</span>
                <input
                  className="tf-input tf-batch-comment"
                  value={batchComment}
                  onChange={event => setBatchComment(event.target.value)}
                  placeholder="打回原因（必填）"
                  aria-label="批量打回批语"
                  maxLength={4000}
                />
                <button type="button" className="tf-btn tf-btn-danger" disabled={batchBusy || selectedReviewIds.length === 0 || batchComment.trim().length === 0} onClick={() => void rejectMany(selectedReviewIds, batchComment)}>{batchBusy ? '打回中…' : '确认打回'}</button>
                <button type="button" className="tf-btn" disabled={batchBusy} onClick={() => { setBatchConfirm(null); setBatchComment('') }}>再想想</button>
              </>
            ) : (
              <>
                {selectedReviewIds.length > 0 && (
                  <button type="button" className="tf-btn tf-btn-primary" disabled={batchBusy} onClick={() => setBatchConfirm('approve')}>通过所选（{selectedReviewIds.length}）</button>
                )}
                {selectedReviewIds.length > 0 && (
                  <button type="button" className="tf-btn tf-btn-danger" disabled={batchBusy} onClick={() => setBatchConfirm('reject')}>打回所选（{selectedReviewIds.length}）</button>
                )}
                {selectedArchivableIds.length > 0 && (
                  <button type="button" className="tf-btn tf-btn-danger" disabled={batchBusy} onClick={() => setBatchConfirm('archive')}>归档所选（{selectedArchivableIds.length}）</button>
                )}
                <button type="button" className="tf-btn" disabled={batchBusy} onClick={() => { setBatchMode(false); setBatchSelected({}); setBatchComment('') }}>取消</button>
              </>
            )}
            <span className="tf-hint">可勾选：待验收（通过/打回）· 已完成/已取消（归档）</span>
          </span>
        )}
        {onClose !== undefined && (
          <button type="button" className="tf-btn" onClick={onClose} aria-label="返回会话">✕ 返回会话</button>
        )}
        <span className="tf-sse-bar">{sseUp ? '' : '实时同步已断开，正在重连…'}</span>
      </div>

      {state === null && loadError === null ? (
        <BoardSkeleton />
      ) : tasks.length === 0 ? (
        <EmptyBoard onCreate={() => setCreateOpen(true)} />
      ) : (
        <div className="tf-columns">
          {groups.map(group => (
            <section className="tf-column" key={group.id} role="list" aria-label={group.title}>
              <header className="tf-column-head">
                <span>{group.title}</span>
                <span className={`tf-column-count${group.id === 'review' && group.cards.length > 0 ? ' hot' : ''}`}>{group.cards.length}</span>
              </header>
              <div className="tf-column-cards">
                {group.cards.map(card => (
                  <TaskCard
                    key={card.task.id}
                    card={card}
                    onOpen={() => setSelectedId(card.task.id)}
                    batchMode={batchMode}
                    selected={batchSelected[card.task.id] ?? false}
                    onToggleSelect={() => setBatchSelected(sel => ({ ...sel, [card.task.id]: !(sel[card.task.id] ?? false) }))}
                    onArchive={async taskId => { await dispatch({ type: 'archiveTask', taskId } as never) }}
                  />
                ))}
                {group.cards.length === 0 && <div className="tf-column-empty">暂无任务</div>}
              </div>
            </section>
          ))}
        </div>
      )}

      {createOpen && (
        <CreateModal
          onClose={() => setCreateOpen(false)}
          dispatch={dispatch}
          transport={transport}
        />
      )}
      {selected !== null && (
        <DetailModal
          task={selected}
          focusApprovalId={focusApprovalId}
          onClose={() => { setSelectedId(null); setFocusApprovalId(null) }}
          dispatch={dispatch}
          onRefresh={refresh}
          transport={transport}
        />
      )}
    </div>
  )
}

// —— 卡片 ——

/** 可归档状态（已完成列：done / cancelled；2026-09-12 卡片归档入口仅对这些出现）。 */
function isArchivable(status: Task['status']): boolean {
  return status === 'done' || status === 'cancelled'
}

/** 批量可勾选状态（2026-09-15 FR-14）：待验收（通过/打回）+ 可归档（归档）。 */
function isBatchSelectable(status: Task['status']): boolean {
  return status === 'review' || isArchivable(status)
}

function TaskCard({
  card,
  onOpen,
  batchMode,
  selected,
  onToggleSelect,
  onArchive,
}: {
  card: CardSummary
  onOpen: () => void
  batchMode: boolean
  selected: boolean
  onToggleSelect: () => void
  onArchive: (taskId: string) => Promise<void>
}): JSX.Element {
  const { task } = card
  const blocked = task.status === 'blocked'
  const running = task.status === 'decomposing' || task.status === 'in-progress'
  const archivable = isArchivable(task.status)
  const batchSelectable = isBatchSelectable(task.status)
  // 卡片归档（2026-09-12）：两段式确认，避免误归档
  const [confirmArchive, setConfirmArchive] = useState(false)
  const [archiving, setArchiving] = useState(false)

  const activate = (): void => {
    if (batchMode) {
      if (batchSelectable) onToggleSelect()
    } else {
      onOpen()
    }
  }
  const handleArchive = async (): Promise<void> => {
    setArchiving(true)
    try {
      await onArchive(task.id)
    } finally {
      setArchiving(false)
      setConfirmArchive(false)
    }
  }

  const cardClass = `tf-card${archivable ? ' has-actions' : ''}${batchMode ? ' tf-batch' : ''}`
  return (
    <div
      role="button"
      tabIndex={0}
      className={cardClass}
      data-status={task.status}
      onClick={activate}
      onKeyDown={event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          activate()
        }
      }}
      title={task.description !== '' ? task.description : task.title}
      aria-label={`打开任务 ${task.title}`}
    >
      {batchMode && (
        <input
          type="checkbox"
          className="tf-card-check"
          checked={selected}
          disabled={!batchSelectable}
          aria-label={`选择任务 ${task.title}`}
          onClick={event => event.stopPropagation()}
          onChange={() => { if (batchSelectable) onToggleSelect() }}
        />
      )}
      {!batchMode && archivable && (
        <span className="tf-card-actions">
          {confirmArchive ? (
            <>
              <button
                type="button"
                className="tf-card-mini primary"
                disabled={archiving}
                onClick={event => { event.stopPropagation(); void handleArchive() }}
              >
                {archiving ? '归档中…' : '确认归档'}
              </button>
              <button
                type="button"
                className="tf-card-mini"
                disabled={archiving}
                onClick={event => { event.stopPropagation(); setConfirmArchive(false) }}
              >
                取消
              </button>
            </>
          ) : (
            <button
              type="button"
              className="tf-card-mini"
              title="归档任务（需确认；归档后在看板隐藏，可在时间线/详情留痕）"
              onClick={event => { event.stopPropagation(); setConfirmArchive(true) }}
            >
              归档
            </button>
          )}
        </span>
      )}
      <span className="tf-card-title">{task.title}</span>
      {task.description !== '' && <span className="tf-card-desc">{task.description}</span>}
      <span className="tf-progress" role="img" aria-label={`进度 ${card.doneCount}/${card.totalCount}`}>
        <span className="tf-progress-bar" style={{ width: `${Math.round(progressRatio(card) * 100)}%` }} />
      </span>
      <span className="tf-card-meta">
        <span className="tf-status-tag" data-status={task.status}>
          <i aria-hidden="true" />
          {statusLabel(task.status)}
        </span>
        {card.totalCount > 0 && (
          <span>
            <span className="tf-meta-strong">{card.doneCount}/{card.totalCount}</span> 子任务
          </span>
        )}
        {task.round > 1 && <span className="tf-chip">第 {task.round} 轮</span>}
        {running && <span className="tf-card-spinner" aria-hidden="true" />}
        {card.awaitingHuman === 'approval' && <span className="tf-chip tf-chip-warn">待审批</span>}
        {card.awaitingHuman === 'permission' && <span className="tf-chip tf-chip-warn">执行需确认</span>}
        {card.awaitingHuman === 'review' && <span className="tf-chip tf-chip-warn">等验收</span>}
        {blocked && card.blockedReason !== undefined && (
          <span className="tf-chip" title={card.blockedReason}>受阻</span>
        )}
        <span className="tf-time">{relativeTime(card.lastActivity)}</span>
      </span>
    </div>
  )
}

// —— 三态 ——

function BoardSkeleton(): JSX.Element {
  return (
    <div className="tf-columns" aria-busy="true" aria-label="加载中">
      {[0, 1, 2, 3].map(i => (
        <section className="tf-column" key={i}>
          <div className="tf-skeleton" style={{ height: 18 }} />
          <div className="tf-skeleton" />
          <div className="tf-skeleton" />
        </section>
      ))}
    </div>
  )
}

function EmptyBoard({ onCreate }: { onCreate: () => void }): JSX.Element {
  return (
    <div className="tf-empty">
      <div className="tf-empty-art" aria-hidden="true">🗂️</div>
      <div>还没有任务。用一句话创建第一个任务，AI 会补全验收标准并拆解成子任务。</div>
      <div>
        <button type="button" className="tf-btn tf-btn-primary" onClick={onCreate}>创建第一个任务</button>
      </div>
    </div>
  )
}

// —— 新建抽屉（FR-01/§4.1）——

// —— 新建弹窗（FR-01/§4.1 + FR-21/FR-22，Bento 单列）——
// 能力（FR-22）：只选不写——选定后由 Host 调整拆解/验收口径，正文不出现预设文字。
// 工作目录（FR-21）：目录选择器（/api/taskflow/dirs 浏览），不要求手填。

const CAPABILITY_CHOICES = CAPABILITIES

/** 任务级模型选择的编码/解码（与全局设置浮层同款 provider::model 形态）。 */
function decodeModelChoice(choice: string): { provider: string; model: string } {
  const separator = choice.indexOf('::')
  return { provider: choice.slice(0, separator), model: choice.slice(separator + 2) }
}
// 档位须落在协议白名单 [1,99] 内（validateMaxRounds，防失控开关口径）——超出即 ActionFormatError，创建直接失败。
const ROUND_CHOICES: Array<{ value: number | null; label: string }> = [
  { value: 30, label: '30' },
  { value: 60, label: '60' },
  { value: 90, label: '90' },
  { value: null, label: '无限' },
]

function CreateModal({
  onClose,
  dispatch,
  transport,
}: {
  onClose: () => void
  dispatch: (action: Record<string, unknown>) => Promise<DispatchResult>
  transport: TaskflowTransport
}): JSX.Element {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [objective, setObjective] = useState('')
  const [acceptanceText, setAcceptanceText] = useState('')
  /** 执行模式（§7.1b）：胶囊滑选，默认完全权限（用户拍板 D1）。 */
  const [mode, setMode] = useState<'auto' | 'approval'>('auto')
  /** 能力预设（FR-22）：单选可取消；只影响 Host 侧口径。 */
  const [capability, setCapability] = useState<string | null>(null)
  /** 工作目录（FR-21）：空 = 宿主默认工作区。 */
  const [workspace, setWorkspace] = useState('')
  const [wsPickerOpen, setWsPickerOpen] = useState(false)
  const [wsBrowse, setWsBrowse] = useState('/')
  const [wsDirs, setWsDirs] = useState<Array<{ name: string; path: string }>>([])
  const [wsParent, setWsParent] = useState<string | null>(null)
  const [wsError, setWsError] = useState<string | null>(null)
  /** 迭代上限（FR-22 改版）：预设档位单选，null = 无限。 */
  const [maxRounds, setMaxRounds] = useState<number | null>(null)
  /** FR-24：模型目录（任务级覆盖下拉数据源）+ 全局设置镜像（展示默认值）。 */
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null)
  const [globalSettings, setGlobalSettings] = useState<GlobalSettings | null>(null)
  /** null = 跟随全局设置；否则 'provider::model'（与全局设置浮层同款编码）。 */
  const [modelChoice, setModelChoice] = useState('')
  /** 并发数输入：null = 未手动改（展示全局默认值）；提交前校验 1–8 整数。 */
  const [concurrencyInput, setConcurrencyInput] = useState<string | null>(null)
  const [autoStart, setAutoStart] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      // FR-23：全局设置（默认子 agent / 并发）+ 预设目录；任一失败静默降级（创建流程不因此卡住）
      try {
        const current = await transport.getSettings()
        if (!cancelled) setGlobalSettings(current)
      } catch { /* 全局设置读不到：字段只显示「跟随全局」 */ }
      try {
        const models = await transport.getModels()
        if (!cancelled) setCatalog(models)
      } catch { /* 模型目录读不到：只剩「跟随全局设置」项 */ }
    })()
    return () => { cancelled = true }
  }, [transport])

  const browseDirs = async (target: string): Promise<void> => {
    setWsError(null)
    try {
      const response = await fetch(`/api/taskflow/dirs?path=${encodeURIComponent(target)}`)
      const body = (await response.json()) as { ok?: boolean; path?: string; parent?: string | null; dirs?: Array<{ name: string; path: string }>; error?: string }
      if (!response.ok || body.path === undefined) throw new Error(body.error ?? `HTTP ${response.status}`)
      setWsBrowse(body.path)
      setWsDirs(body.dirs ?? [])
      setWsParent(body.parent ?? null)
    } catch (browseError) {
      setWsError(browseError instanceof Error ? browseError.message : String(browseError))
    }
  }

  const togglePicker = (): void => {
    if (wsPickerOpen) {
      setWsPickerOpen(false)
      return
    }
    setWsPickerOpen(true)
    const start = workspace.trim().length > 0 ? workspace.trim() : '/'
    void browseDirs(start)
  }

  // FR-23：并发数有效值（未手动改 = 全局默认；全局也读不到 = 1）
  const concurrency = (() => {
    const raw = concurrencyInput ?? String(globalSettings?.maxConcurrentSubtasks ?? 1)
    const value = Number.parseInt(raw, 10)
    return Number.isInteger(value) && value >= 1 && value <= 8 ? value : null
  })()
  // 提交门禁：禁用时给原因，不再只是静默灰按钮。
  const submitBlocked = title.trim().length === 0 ? '标题必填'
    : description.trim().length === 0 ? '描述必填'
    : concurrency === null ? '并发数须为 1–8 的整数'
    : null
  const dialogRef = useRef<HTMLElement>(null)
  useDialogA11y(dialogRef, onClose)

  const submit = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    const acceptance = acceptanceText
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0)
      .map(text => ({ text }))
    const result = await dispatch({
      type: 'createTask',
      title,
      description,
      acceptance: acceptance.length > 0 ? acceptance : undefined,
      ...(objective.trim().length > 0 ? { objective: objective.trim() } : {}),
      ...(maxRounds !== null ? { maxRounds } : {}),
      pins: {
        permission: mode === 'auto' ? 'workspace-write' : 'read-only',
        executionMode: mode,
        ...(workspace.trim().length > 0 ? { workspace: workspace.trim() } : {}),
      },
      ...(capability !== null ? { capability } : {}),
      ...(modelChoice !== '' ? { model: decodeModelChoice(modelChoice) } : {}),
      maxConcurrentSubtasks: concurrency,
      autoStart,
    })
    setBusy(false)
    if (result.ok) onClose()
    else setError(result.error ?? '创建失败')
  }

  return (
    <div className="tf-overlay tf-overlay-center" onClick={event => { if (event.target === event.currentTarget) onClose() }}>
      <aside
        className="tf-modal tf-create-modal"
        role="dialog"
        aria-modal="true"
        aria-label="新建任务"
        ref={dialogRef}
        tabIndex={-1}
      >
        <header className="tf-modal-head">
          <span className="tf-modal-title">新建任务</span>
          <button type="button" className="tf-icon-btn" onClick={onClose} aria-label="关闭">✕</button>
        </header>
        <div className="tf-modal-body">
          {error !== null && <div className="tf-banner" role="alert">{error}</div>}
          <div className="tf-bento">
            {/* 格 1 · 任务 */}
            <section className="tf-bento-cell" aria-label="任务内容">
              <span className="tf-section-title">任务</span>
              <div className="tf-field">
                <label htmlFor="tf-title">标题 *</label>
                <input id="tf-title" className="tf-input" maxLength={120} placeholder="一句话说清要做什么" value={title} onChange={e => setTitle(e.target.value)} />
              </div>
              <div className="tf-field">
                <label htmlFor="tf-desc">描述 *</label>
                <textarea id="tf-desc" className="tf-textarea" value={description} onChange={e => setDescription(e.target.value)} placeholder="把你的诉求写清楚；验收标准可以不给，AI 拆解时会补全建议稿" />
              </div>
              <div className="tf-field">
                <label htmlFor="tf-obj">目标（可选）</label>
                <input id="tf-obj" className="tf-input" value={objective} onChange={e => setObjective(e.target.value)} />
              </div>
              <div className="tf-field">
                <label htmlFor="tf-ac">验收标准（可选，每行一条）</label>
                <textarea id="tf-ac" className="tf-textarea" value={acceptanceText} onChange={e => setAcceptanceText(e.target.value)} placeholder={'留空由 AI 补全，例如：\n全部测试通过\nREADME 更新使用说明'} />
              </div>
              <div className="tf-field">
                <label>能力（可选）</label>
                <div className="tf-pill-row" role="group" aria-label="能力">
                  {CAPABILITY_CHOICES.map(c => (
                    <button
                      key={c.id}
                      type="button"
                      className={`tf-pill${capability === c.id ? ' active' : ''}`}
                      aria-pressed={capability === c.id}
                      title={c.label}
                      onClick={() => setCapability(capability === c.id ? null : c.id)}
                    >
                      {c.label}
                    </button>
                  ))}
                </div>
              </div>
            </section>
            {/* 格 2 · 执行 */}
            <section className="tf-bento-cell" aria-label="执行设置">
              <span className="tf-section-title">执行</span>
              <div className="tf-field">
                <label>执行模式</label>
                <div className="tf-capsule" role="radiogroup" aria-label="执行模式">
                  <span className={`tf-capsule-thumb${mode === 'approval' ? ' tf-capsule-right' : ''}`} aria-hidden="true" />
                  <button type="button" role="radio" aria-checked={mode === 'auto'} className="tf-capsule-opt" onClick={() => setMode('auto')}>🔓 完全权限</button>
                  <button type="button" role="radio" aria-checked={mode === 'approval'} className="tf-capsule-opt" onClick={() => setMode('approval')}>🔒 需要审批</button>
                </div>
              </div>
              <div className="tf-field">
                <label>工作目录（可选）</label>
                <div className="tf-ws-row">
                  <button
                    type="button"
                    className={`tf-btn tf-ws-toggle${workspace.trim().length > 0 ? ' tf-ws-set' : ''}`}
                    aria-expanded={wsPickerOpen}
                    title={workspace.trim().length > 0 ? workspace : '宿主当前工作区'}
                    onClick={() => togglePicker()}
                  >
                    <span className="tf-ws-toggle-text">{workspace.trim().length > 0 ? workspace : '宿主当前工作区'}</span>
                  </button>
                  {workspace.trim().length > 0 && (
                    <button type="button" className="tf-btn" onClick={() => setWorkspace('')}>清除</button>
                  )}
                </div>
                {wsPickerOpen && (
                  <div className="tf-ws-picker">
                    <div className="tf-ws-crumb" title={wsBrowse}>{wsBrowse}</div>
                    <div className="tf-ws-picker-actions">
                      {wsParent !== null && <button type="button" className="tf-btn" onClick={() => void browseDirs(wsParent)}>上级</button>}
                      <button
                        type="button"
                        className="tf-btn tf-btn-primary"
                        onClick={() => { setWorkspace(wsBrowse); setWsPickerOpen(false) }}
                      >
                        选这个目录
                      </button>
                    </div>
                    {wsError !== null && <span className="tf-hint" role="alert">{wsError}</span>}
                    {wsError === null && wsDirs.length === 0 && <span className="tf-hint">（无子目录）</span>}
                    <div className="tf-ws-list">
                      {wsDirs.map(dir => (
                        <button key={dir.path} type="button" className="tf-ws-item" onClick={() => void browseDirs(dir.path)}>
                          {dir.name}/
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
              <div className="tf-field">
                <label htmlFor="tf-model">模型（默认跟随全局）</label>
                <select
                  id="tf-model"
                  className="tf-select"
                  value={modelChoice}
                  aria-label="任务模型"
                  onChange={e => setModelChoice(e.target.value)}
                >
                  <option value="">跟随全局设置</option>
                  {catalog?.groups.map(group => (
                    <optgroup key={group.id} label={group.name}>
                      {group.models.map(model => (
                        <option key={`${group.id}::${model.id}`} value={`${group.id}::${model.id}`}>{model.name}</option>
                      ))}
                    </optgroup>
                  ))}
                </select>
                <span className="tf-hint">选定后该任务的拆解 / 执行 / 终检都用此模型，不随全局两槽。</span>
              </div>
              <div className="tf-inline-field">
                <label htmlFor="tf-concurrency">并发数</label>
                <input
                  id="tf-concurrency"
                  className="tf-input tf-input-narrow"
                  inputMode="numeric"
                  value={concurrencyInput ?? String(globalSettings?.maxConcurrentSubtasks ?? 1)}
                  aria-label="任务并发数"
                  aria-invalid={concurrency === null}
                  onChange={e => setConcurrencyInput(e.target.value.replace(/[^\d]/g, ''))}
                />
                <span className="tf-hint">1–8；实际取全局上限与该值中较小者</span>
              </div>
              <div className="tf-field">
                <label>迭代上限</label>
                <div className="tf-pill-row" role="radiogroup" aria-label="迭代上限">
                  {ROUND_CHOICES.map(choice => (
                    <button
                      key={choice.label}
                      type="button"
                      role="radio"
                      aria-checked={maxRounds === choice.value}
                      className={`tf-pill${maxRounds === choice.value ? ' active' : ''}`}
                      onClick={() => setMaxRounds(choice.value)}
                    >
                      {choice.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="tf-field">
                <label>
                  <input type="checkbox" checked={autoStart} onChange={e => setAutoStart(e.target.checked)} /> 拆解后自动开工
                </label>
              </div>
            </section>
          </div>
        </div>
        <footer className="tf-modal-foot tf-create-foot">
          {submitBlocked !== null && <span className="tf-hint" role="status">⚠ {submitBlocked}</span>}
          <div className="tf-actions">
            <button type="button" className="tf-btn tf-btn-primary" disabled={busy || submitBlocked !== null} onClick={() => void submit()}>
              {busy ? '创建中…' : '创建并开始拆解'}
            </button>
            <button type="button" className="tf-btn" onClick={onClose}>取消</button>
          </div>
        </footer>
      </aside>
    </div>
  )
}
// —— 周期统计浮层（FR-20：吞吐 / 一次通过率 / 平均迭代轮次 / 拆解采纳率） ——

/** 统计口径的口径说明（面板脚注，和数字放一起才不误导）。 */
const STATS_NOTES: Array<{ metric: string; note: string }> = [
  { metric: '一次通过率', note: 'done 且从未被打回（round=1）的占比' },
  { metric: '平均迭代轮次', note: 'done 任务 round 均值（§9 目标 ≤ 2）' },
  { metric: '拆解采纳率', note: '拆解后未编辑过子任务的任务占比（§9 目标 ≥ 70%）' },
  { metric: '吞吐', note: '按任务级 done 事件时间统计（近 7/30 天）' },
]

function StatsPopover({ tasks, onClose }: { tasks: readonly Task[]; onClose: () => void }): JSX.Element {
  const panelRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    const onMouseDown = (event: MouseEvent): void => {
      const target = event.target instanceof Node ? event.target : null
      if (target === null) return
      const anchor = panelRef.current?.closest('.tf-settings-anchor') ?? null
      if (panelRef.current?.contains(target) === true) return
      if (anchor !== null && anchor.contains(target)) return
      onClose()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onMouseDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onMouseDown)
    }
  }, [onClose])

  const stats = reportStats(tasks)
  return (
    <div className="tf-popover tf-stats-pop" ref={panelRef} role="dialog" aria-label="周期统计">
      <div className="tf-pop-head">
        <span className="tf-pop-title">周期统计</span>
        <button type="button" className="tf-icon-btn" onClick={onClose} aria-label="关闭周期统计">✕</button>
      </div>
      <div className="tf-stats-grid">
        <div className="tf-stat">
          <span className="tf-stat-value">{stats.doneLast7d}</span>
          <span className="tf-stat-label">近 7 天完成</span>
        </div>
        <div className="tf-stat">
          <span className="tf-stat-value">{stats.doneLast30d}</span>
          <span className="tf-stat-label">近 30 天完成</span>
        </div>
        <div className="tf-stat">
          <span className="tf-stat-value">{stats.doneTotal}</span>
          <span className="tf-stat-label">累计完成</span>
        </div>
        <div className="tf-stat">
          <span className="tf-stat-value">{stats.activeCount}</span>
          <span className="tf-stat-label">进行中</span>
        </div>
        <div className="tf-stat">
          <span className="tf-stat-value">{percentOf(stats.firstPassRate)}</span>
          <span className="tf-stat-label">一次通过率</span>
        </div>
        <div className="tf-stat">
          <span className="tf-stat-value">{decimalOf(stats.avgRounds)}</span>
          <span className="tf-stat-label">平均迭代轮次</span>
        </div>
        <div className="tf-stat">
          <span className="tf-stat-value">{percentOf(stats.decomposeAdoptionRate)}</span>
          <span className="tf-stat-label">拆解采纳率</span>
        </div>
        <div className="tf-stat">
          <span className="tf-stat-value">{stats.reworkedCount}</span>
          <span className="tf-stat-label">被打回过的任务</span>
        </div>
      </div>
      <div className="tf-stats-notes">
        {STATS_NOTES.map(note => (
          <span className="tf-hint" key={note.metric}>{note.metric}：{note.note}</span>
        ))}
      </div>
    </div>
  )
}

// —— 详情弹窗（FR-11 五区；验收工作台容器）——

/**
 * 弹窗无障碍（一次性装配）：初始焦点落在弹窗本体、Tab 焦点陷阱（循环不出
 * 弹窗，遮罩后的看板不可达）、Esc 关闭、卸载时焦点还给打开者。
 * onClose 走 ref，避免回调变化导致重跑 effect 抢焦点。
 */
function useDialogA11y(ref: React.RefObject<HTMLElement | null>, onClose: () => void): void {
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  useEffect(() => {
    const dialog = ref.current
    if (dialog === null) return
    const previous = document.activeElement as HTMLElement | null
    const focusables = (): HTMLElement[] =>
      Array.from(dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ))
    dialog.focus()
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onCloseRef.current()
        return
      }
      if (event.key !== 'Tab') return
      const list = focusables()
      if (list.length === 0) return
      const first = list[0]!
      const last = list[list.length - 1]!
      const active = document.activeElement
      if (dialog.contains(active) === false || (event.shiftKey && active === first) || (!event.shiftKey && active === last)) {
        event.preventDefault()
        ;(event.shiftKey ? last : first).focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      previous?.focus()
    }
  }, [ref])
}

function DetailModal({
  task,
  focusApprovalId,
  onClose,
  dispatch,
  onRefresh,
  transport,
}: {
  task: Task
  focusApprovalId: string | null
  onClose: () => void
  dispatch: (action: Record<string, unknown>) => Promise<DispatchResult>
  onRefresh: () => Promise<void>
  transport: TaskflowTransport
}): JSX.Element {
  // 默认落点（2026-09-12 口径 + 2026-09-21 流程图）：review = 等终批，落验收页
  // （验收页专注验收）；done = 验收完成，落「产物」页；in-progress = 执行中，
  // 落「流程」页（点开就看正在执行的 DAG）；其余状态从合同看起。
  const [tab, setTab] = useState<TabId>(
    task.status === 'review' ? 'review'
    : task.status === 'done' ? 'deliverables'
    : task.status === 'in-progress' ? 'flow'
    : 'contract',
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dialogRef = useRef<HTMLElement>(null)
  useDialogA11y(dialogRef, onClose)
  const onResizeStart = useModalResize(dialogRef)
  const approvalPending = (task.approvals ?? []).some(a => a.status === 'pending')

  const act = async (action: Record<string, unknown>): Promise<void> => {
    setBusy(true)
    setError(null)
    const result = await dispatch({ taskId: task.id, ...action })
    setBusy(false)
    if (!result.ok) setError(`${result.code ?? ''}: ${result.error ?? '操作失败'}`)
    await onRefresh()
  }

  return (
    <div className="tf-overlay tf-overlay-center" onClick={event => { if (event.target === event.currentTarget) onClose() }}>
      <aside
        className="tf-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`任务详情 ${task.title}`}
        ref={dialogRef}
        tabIndex={-1}
      >
        <header className="tf-modal-head">
          <span className="tf-status-tag" data-status={task.status}>
            <i aria-hidden="true" />
            {statusLabel(task.status)}
          </span>
          <span className="tf-modal-title" title={task.title}>{task.title}</span>
          {task.round > 1 && <span className="tf-chip">第 {task.round} 轮</span>}
          {approvalPending && <span className="tf-chip tf-chip-warn">待审批</span>}
          <button type="button" className="tf-icon-btn" onClick={onClose} aria-label="关闭">✕</button>
        </header>
        <nav className="tf-tabs" role="tablist">
          {TABS.map(item => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              className="tf-tab"
              onClick={() => setTab(item.id)}
            >
              {item.title}
              {item.id === 'review' && task.status === 'review' && ' ●'}
            </button>
          ))}
        </nav>
        {/* 验收 tab 与流程 tab 是填充式工作台（内部自带滚动与吸底操作），其余 tab 走普通滚动 */}
        <div className={tab === 'review' || tab === 'flow' ? 'tf-modal-body tf-modal-body-fill' : 'tf-modal-body'}>
          {error !== null && <div className="tf-banner" role="alert">{error}</div>}
          <ApprovalSection task={task} busy={busy} act={act} focusApprovalId={focusApprovalId} />
          {tab === 'contract' && <ContractTab task={task} />}
          {tab === 'flow' && <FlowTab task={task} />}
          {tab === 'subtasks' && <SubtasksTab task={task} />}
          {tab === 'review' && <ReviewTab task={task} busy={busy} act={act} transport={transport} />}
          {tab === 'deliverables' && <DeliverablesTab task={task} transport={transport} />}
          {tab === 'decompose' && <DecomposeTab task={task} />}
        </div>
        <footer className="tf-modal-foot">
          <TaskActions task={task} busy={busy} act={act} />
        </footer>
        {/* 底部拖拽手柄：拉高弹窗，多出的高度全给弹性块（流程 tab = 轨迹面板；验收 tab = 判定面）。 */}
        <div
          className="tf-modal-resize"
          role="separator"
          aria-orientation="horizontal"
          aria-label="拖拽调整弹窗高度"
          onPointerDown={onResizeStart}
        >
          <span aria-hidden="true" />
        </div>
      </aside>
    </div>
  )
}

/** 弹窗高度拖拽（2026-09-22）：按住底部手柄纵向拉伸；clamp 在 480px–视口内。
 *  只改弹窗高度，不碰布局——多出的空间由 tab 内部的弹性块（flex:1）自然吸收。 */
function useModalResize(
  dialogRef: { current: HTMLElement | null },
): (event: ReactPointerEvent) => void {
  const stateRef = useRef<{ startY: number; startH: number } | null>(null)
  return useCallback((event: React.PointerEvent) => {
    event.preventDefault()
    const modal = dialogRef.current
    if (modal === null) return
    stateRef.current = { startY: event.clientY, startH: modal.offsetHeight }
    const move = (ev: PointerEvent): void => {
      const start = stateRef.current
      if (start === null) return
      const max = window.innerHeight - 16
      const next = Math.min(max, Math.max(480, start.startH + (ev.clientY - start.startY)))
      modal.style.height = `${Math.round(next)}px`
    }
    const up = (): void => {
      stateRef.current = null
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }, [dialogRef])
}

// —— 权限审批区（§7.1b：两档裁决 = 完全放行 / 拒绝）——

function ApprovalSection({
  task,
  busy,
  act,
  focusApprovalId,
}: {
  task: Task
  busy: boolean
  act: (action: Record<string, unknown>) => Promise<void>
  focusApprovalId: string | null
}): JSX.Element | null {
  const [note, setNote] = useState('')
  const pending: PendingApprovalView[] = pendingApprovalsOf(task)
  if (pending.length === 0) return null
  return (
    <div className="tf-section tf-approvals" role="region" aria-label="权限审批">
      <span className="tf-section-title">权限审批（{pending.length} 条待裁决）</span>
      {pending.map(approval => (
        <div
          className={`tf-approval${focusApprovalId === approval.id ? ' tf-approval-focus' : ''}`}
          key={approval.id}
          data-approval-id={approval.id}
        >
          <div className="tf-item-head">
            <span className="tf-chip tf-chip-warn">{approval.toolName}</span>
            <span className="tf-item-title">「{approval.subtaskTitle}」请求提权</span>
            <span className="tf-time">{relativeTime(approval.createdAt)}</span>
          </div>
          {approval.reason !== undefined && <span className="tf-approval-reason">{approval.reason}</span>}
          <div className="tf-actions">
            <button
              type="button"
              className="tf-btn tf-btn-primary"
              disabled={busy}
              title="会话权限原地提升，后续不再逐次审批"
              onClick={() => void act({ type: 'decideApproval', approvalId: approval.id, decision: 'allow' })}
            >
              ✅ 完全放行（本会话）
            </button>
            <button
              type="button"
              className="tf-btn tf-btn-danger"
              disabled={busy}
              title="仅拒绝这一次调用，AI 可调整方案"
              onClick={() => void act({
                type: 'decideApproval',
                approvalId: approval.id,
                decision: 'reject',
                ...(note.trim().length > 0 ? { note } : {}),
              })}
            >
              ✕ 拒绝
            </button>
          </div>
        </div>
      ))}
      <div className="tf-field">
        <label htmlFor="tf-approval-note">批语（可选，随裁决留痕）</label>
        <input
          id="tf-approval-note"
          className="tf-input"
          value={note}
          onChange={event => setNote(event.target.value)}
          placeholder="例如：只允许写 reports/ 目录"
        />
      </div>
    </div>
  )
}

function TaskActions({
  task,
  busy,
  act,
}: {
  task: Task
  busy: boolean
  act: (action: Record<string, unknown>) => Promise<void>
}): JSX.Element {
  const [confirming, setConfirming] = useState<'cancel' | null>(null)
  return (
    <div className="tf-actions tf-task-actions">
      {task.status === 'draft' && (
        <button type="button" className="tf-btn tf-btn-primary" disabled={busy} onClick={() => void act({ type: 'startDecompose' })}>开始拆解</button>
      )}
      {task.status === 'blocked' && task.subtasks.length === 0 && (
        <button type="button" className="tf-btn tf-btn-primary" disabled={busy} onClick={() => void act({ type: 'startDecompose' })}>重新拆解</button>
      )}
      {task.status === 'ready' && (
        <button
          type="button"
          className="tf-btn tf-btn-primary"
          disabled={busy}
          onClick={() => void act({ type: 'startImplementation', ...(task.permissionConfirmed ? {} : { confirmPermission: true }) })}
        >
          开始实现{task.permissionConfirmed ? '' : '（确认执行权限）'}
        </button>
      )}
      {task.status === 'in-progress' && !task.permissionConfirmed && (
        <button type="button" className="tf-btn tf-btn-primary" disabled={busy} onClick={() => void act({ type: 'startImplementation', confirmPermission: true })}>
          确认执行权限并继续
        </button>
      )}
      {task.status === 'blocked' && task.subtasks.some(s => s.status === 'blocked') && (
        <button type="button" className="tf-btn tf-btn-primary" disabled={busy} onClick={() => void act({ type: 'retryBlocked' })}>重试受阻项</button>
      )}
      {/* 仅当 block 的真正原因是「打回迭代达上限」时才提供提上限入口；
          拆解失败/重试耗尽等其他 blocked 原因不归它管（避免误导人中途提上限） */}
      {task.status === 'blocked' && task.maxRounds !== null && task.round >= task.maxRounds && (
        <button type="button" className="tf-btn" disabled={busy} onClick={() => void act({ type: 'raiseMaxRounds', maxRounds: task.maxRounds! + 2 })}>
          提高迭代上限至 {task.maxRounds + 2}
        </button>
      )}
      {(task.status === 'done' || task.status === 'cancelled') && (
        <button type="button" className="tf-btn" disabled={busy} onClick={() => void act({ type: 'archiveTask' })}>归档</button>
      )}
      {!['done', 'cancelled', 'archived'].includes(task.status) && (
        confirming === 'cancel' ? (
          <>
            <button type="button" className="tf-btn tf-btn-danger" disabled={busy} onClick={() => { setConfirming(null); void act({ type: 'cancelTask', confirm: true }) }}>确认取消（终态）</button>
            <button type="button" className="tf-btn" onClick={() => setConfirming(null)}>再想想</button>
          </>
        ) : (
          <button type="button" className="tf-btn tf-btn-danger" disabled={busy} onClick={() => setConfirming('cancel')}>取消任务…</button>
        )
      )}
    </div>
  )
}

// —— 各标签页 ——

// 合同 tab（2026-09-22 改版：白卡三段 = 目标 / 验收标准 / 条款，视觉语言对齐
// 验收台判定面与创建弹窗 Bento；原「键值表 + 平铺列表」退役）。
function ContractTab({ task }: { task: Task }): JSX.Element {
  const refined = task.contract.sourceOfAcceptance === 'ai-refined' && task.contract.originalHumanAcceptance !== undefined
  const sourceLabel = task.contract.sourceOfAcceptance === 'human' ? '用户手写' : task.contract.sourceOfAcceptance === 'ai-drafted' ? 'AI 建议稿' : 'AI 细化'
  return (
    <>
      <div className="tf-ct-card tf-ct-goal-card">
        <div className="tf-ct-head">
          <span className="tf-ct-name">目标</span>
          <span className="tf-ct-rule" />
          {!task.permissionConfirmed && <span className="tf-chip tf-chip-amber"><i />执行权限待确认</span>}
        </div>
        <div className="tf-ct-goal">{task.contract.objective}</div>
      </div>
      <div className="tf-ct-card tf-ct-ac-card">
        <div className="tf-ct-head">
          <span className="tf-ct-name">验收标准</span>
          <span className="tf-ct-rule" />
          <span className="tf-ct-term"><span className="tf-ct-k">来源</span>{sourceLabel}</span>
        </div>
        <AcceptanceList items={task.contract.acceptance} />
        {refined && (
          <div className="tf-ct-origin">
            {(task.contract.originalHumanAcceptance ?? []).map(item => (
              <span className="tf-ct-origin-q" key={item.id}>{item.text}</span>
            ))}
          </div>
        )}
      </div>
      <div className="tf-ct-card tf-ct-term-card">
        <div className="tf-ct-head">
          <span className="tf-ct-name">条款</span>
          <span className="tf-ct-rule" />
        </div>
        <div className="tf-ct-terms">
          <span className="tf-ct-k">权限</span>
          <span className="tf-ct-v"><span className="tf-chip tf-chip-blue">{task.contract.pins.permission}</span></span>
          <span className="tf-ct-k">迭代</span>
          <span className="tf-ct-v"><span className="tf-chip tf-chip-num"><b>{task.round}</b><small> / {task.maxRounds === null ? '不限' : task.maxRounds} 轮</small></span></span>
          {task.contract.pins.workspace.trim().length > 0 && (
            <>
              <span className="tf-ct-k">工作目录</span>
              <span className="tf-ct-v"><code className="tf-ws-path" title={task.contract.pins.workspace}>{task.contract.pins.workspace}</code></span>
            </>
          )}
        </div>
      </div>
    </>
  )
}

function AcceptanceList({ items }: { items: AcceptanceItem[] }): JSX.Element {
  if (items.length === 0) return <span className="tf-hint">（空 —— AI 拆解时会补全建议稿）</span>
  return (
    <>
      {items.map((item, i) => (
        <div className="tf-ac-row" key={item.id}>
          {/* 展示位用短序号（AC-1/AC-2…）；item.id 是内部机器 id，不外显 */}
          <span className="tf-ac-badge">AC-{i + 1}</span>
          <span>{item.text}</span>
        </div>
      ))}
    </>
  )
}

// —— 流程 tab（FR-12 可视化，2026-09-21）：任务管线的实时执行流程图 ——
// 数据即快照（相位状态 + Subtask.deps/status），SSE change 每推一次整图重渲染，无需后端改动。
// 管线：AI 拆解（药丸）→ 子任务 DAG（卡片，整体右移一层）→ AI 终检（药丸）→ 人工终批（药丸）。

/** DAG 节点卡与间距（px）：坐标 = 槽位换算，蛇形折行铺开。 */
const DAG_NODE_W = 192
const DAG_NODE_H = 62
const DAG_GAP_X = 56
const DAG_GAP_Y = 14
const DAG_PAD = 14
/** 每行槽位数：4 槽 ≈ 1000px，弹窗内横向零滚动零缩放（字号不缩水的关键）。 */
const DAG_SLOTS_PER_BAND = 4
/** 折行之间的纵向间隔（px）。 */
const DAG_BAND_GAP_Y = 56
/** 画布右/左缘弧线余量（px）：行末折返连线在边缘向外鼓出（≤~24px + 箭头），不裁切。 */
const DAG_ARC_MARGIN = 32

/**
 * 蛇形布局几何（2026-09-22）：槽位序列从真实数据推导——拆解(0) + 子任务依赖分层
 * (1..n) + 终检(n+1) + 终批(n+2)，每行 DAG_SLOTS_PER_BAND 槽折行；偶数行左→右、
 * 奇数行右→左（折返处两行首尾同列相接，连线自然下垂）。与流程具体形态无关：
 * 无子任务、链式、多层并行都按同一规则折行。
 */
function dagGeometry(rows: number, totalLayers: number) {
  const bandBlock = rows * DAG_NODE_H + Math.max(0, rows - 1) * DAG_GAP_Y
  const bands = Math.max(1, Math.ceil(totalLayers / DAG_SLOTS_PER_BAND))
  return {
    /** 恒定宽度：不随任务大小变化（切换卡片零跳动）；两侧留弧线余量防裁切。 */
    width: DAG_PAD * 2 + DAG_ARC_MARGIN * 2 + DAG_SLOTS_PER_BAND * DAG_NODE_W + (DAG_SLOTS_PER_BAND - 1) * DAG_GAP_X,
    height: DAG_PAD * 2 + bands * bandBlock + (bands - 1) * DAG_BAND_GAP_Y,
    /** 槽位 → 画布坐标（index = 层内第几个节点）。 */
    pos: (slot: number, index: number): { x: number; y: number } => {
      const band = Math.floor(slot / DAG_SLOTS_PER_BAND)
      const local = slot % DAG_SLOTS_PER_BAND
      const visual = band % 2 === 0 ? local : DAG_SLOTS_PER_BAND - 1 - local
      return {
        x: DAG_PAD + DAG_ARC_MARGIN + visual * (DAG_NODE_W + DAG_GAP_X),
        y: DAG_PAD + band * (bandBlock + DAG_BAND_GAP_Y) + index * (DAG_NODE_H + DAG_GAP_Y),
      }
    },
  }
}

/** 边路径：出口/入口侧独立指定（1 = 卡片右侧，-1 = 左侧）。出口侧跟随源所在行的
 *  行进方向（左→右行出右边、右→左行出左边），入口侧跟随目标所在行方向——
 *  行内连线是干净的短弧，行末折返在边缘外鼓一个小弧再回来。 */
function dagEdgePath(x1: number, y1: number, x2: number, y2: number, exitRight: boolean, entryRight: boolean): string {
  const sx = exitRight ? 1 : -1
  const ex = entryRight ? 1 : -1
  const dx = Math.max(24, Math.abs(x2 - x1) / 2)
  return `M ${x1} ${y1} C ${x1 + sx * dx} ${y1}, ${x2 + ex * dx} ${y2}, ${x2} ${y2}`
}

/** 槽位所在行的行进方向：奇数行右→左（入口/出口都在左边），偶数行左→右（在右边）。 */
function dagEntryRight(slot: number): boolean {
  return Math.floor(slot / DAG_SLOTS_PER_BAND) % 2 === 1
}

/** 出口侧 = 源所在行的行进方向（与入口同规则）。 */
function dagExitRight(slot: number): boolean {
  return !dagEntryRight(slot)
}

/** 连线箭头：随边状态着色（默认灰 / 完成绿 / 运行中蓝）；孤儿 dep 桩不挂箭头。 */
function markerFor(edgeClass: string): string {
  if (edgeClass.includes('done')) return 'url(#tf-dag-arrow-done)'
  if (edgeClass.includes('flow')) return 'url(#tf-dag-arrow-flow)'
  return 'url(#tf-dag-arrow)'
}

/** 箭头 marker 定义（三种状态色；orient=auto 随路径末端切线方向旋转）。 */
function DagArrowDefs(): JSX.Element {
  const arrow = (id: string, fillClass: string): JSX.Element => (
    <marker
      key={id}
      id={id}
      viewBox="0 0 10 10"
      refX="9"
      refY="5"
      markerWidth="6.5"
      markerHeight="6.5"
      orient="auto-start-reverse"
    >
      <path d="M 0 0 L 10 5 L 0 10 z" className={fillClass} />
    </marker>
  )
  return (
    <defs>
      {arrow('tf-dag-arrow', 'tf-dag-arrow-default')}
      {arrow('tf-dag-arrow-done', 'tf-dag-arrow-done')}
      {arrow('tf-dag-arrow-flow', 'tf-dag-arrow-flow')}
    </defs>
  )
}

/** 流程图节点选中态：点子任务卡或相位药丸 → 下方展开该节点的执行轨迹。 */
type DagSelection = { kind: 'sub'; id: string } | { kind: 'phase'; id: DagPhaseId }

/** 节点键盘可达（Enter/Space）+ 鼠标/键盘统一入口。 */
function selectNode(event: { type: string; key?: string; preventDefault(): void }, select: () => void): void {
  if (event.type === 'keydown' && event.key !== 'Enter' && event.key !== ' ') return
  event.preventDefault()
  select()
}

function FlowTab({ task }: { task: Task }): JSX.Element {
  const layout = useMemo(() => dagLayout(task), [task])
  const phases = useMemo(() => dagPhases(task), [task])
  const [selected, setSelected] = useState<DagSelection | null>(null)
  const phaseById = new Map(phases.map(p => [p.id, p]))
  const rows = Math.max(1, ...layout.layerSizes)
  const totalLayers = 3 + layout.layerCount // 拆解 + 子任务层 + 终检 + 终批
  const geo = dagGeometry(rows, totalLayers)
  const width = geo.width
  const height = geo.height
  // 槽位定位：子任务层号 +1（拆解占第 0 槽）；终检/终批在 layerCount+1 / +2。
  const dagNodePos = (node: DagNode): { x: number; y: number } => geo.pos(node.layer + 1, node.index)
  const nodeById = new Map(layout.nodes.map(n => [n.sub.id, n]))
  const doneCount = task.subtasks.filter(s => s.status === 'done' || s.status === 'review').length
  // 相位药丸放所在槽位的第一行（稳定不跳；与该槽子任务同排）
  const phasePos = (slot: number) => geo.pos(slot, 0)
  const decomposeBox = phasePos(0)
  const finalcheckBox = phasePos(layout.layerCount + 1)
  const acceptBox = phasePos(layout.layerCount + 2)
  // 根 = 没有被任何有效 dep 边指向的子任务（孤儿 dep 的桩不算入边）
  const targeted = new Set(layout.edges.filter(e => !e.missing).map(e => e.to))
  const roots = layout.nodes.filter(n => !targeted.has(n.sub.id))
  const leaves = layout.nodes.filter(n => !layout.edges.some(e => e.from === n.sub.id))
  const finalcheckRunning = phaseById.get('finalcheck')?.status === 'in-progress'
  return (
    <div className="tf-section tf-flow">
      <span className="tf-section-title">
        执行流程（{doneCount}/{task.subtasks.length} 完成{task.subtasks.length === 0 && task.status === 'decomposing' ? ' · 拆解中' : ''} · 实时）
      </span>
      <span className="tf-hint">
        任务管线蛇形排布（左→右，折行右→左）：药丸 = 阶段（拆解 → 子任务 → 终检 → 终批），卡片 = 子任务。琥珀 = 运行中（呼吸），蓝 = 待核验/待人，绿 = 完成，红 = 受阻，灰 = 等待。点击节点查看它的执行轨迹。
      </span>
      <div className="tf-dag-scroll">
        <svg
          className="tf-dag-svg"
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={`任务执行流程图：拆解、${task.subtasks.length} 个子任务、终检、人工终批`}
        >
          <DagArrowDefs />
          {(() => {
            // —— 相位连线：拆解 → 根（无根时直连终检）；叶子 → 终检 → 终批 ——
            // 出口侧 = 源槽位行方向；入口侧 = 目标槽位行方向。
            const exitX = (box: { x: number }, exitRight: boolean): number => (exitRight ? box.x + DAG_NODE_W : box.x)
            const edgeTo = (fromBox: { x: number; y: number }, fromSlot: number, toBox: { x: number; y: number }, toSlot: number, cls: string, key: string, title: string) => {
              const exitRight = dagExitRight(fromSlot)
              const entryRight = dagEntryRight(toSlot)
              return (
                <path
                  key={key}
                  className={`tf-dag-edge ${cls}`}
                  d={dagEdgePath(
                    exitX(fromBox, exitRight), fromBox.y + DAG_NODE_H / 2,
                    entryX(toBox, entryRight), toBox.y + DAG_NODE_H / 2,
                    exitRight, entryRight,
                  )}
                  markerEnd={markerFor(cls)}
                >
                  <title>{title}</title>
                </path>
              )
            }
            const entryX = (box: { x: number }, entryRight: boolean): number => (entryRight ? box.x + DAG_NODE_W : box.x)
            const decomposeDone = phaseById.get('decompose')?.status === 'done'
            const phaseEdgeClass = decomposeDone ? 'tf-dag-edge-done' : ''
            const finalcheckSlot = layout.layerCount + 1
            const acceptSlot = layout.layerCount + 2
            const headEdges = roots.length > 0
              ? roots.map(root => edgeTo(
                  decomposeBox, 0, dagNodePos(root), root.layer + 1,
                  phaseEdgeClass, `phase-head-${root.sub.id}`,
                  `拆解完成 → ${root.sub.title}`,
                ))
              : [edgeTo(
                  decomposeBox, 0, finalcheckBox, finalcheckSlot,
                  phaseEdgeClass, 'phase-head-direct',
                  task.subtasks.length === 0 ? '拆解 → 终检（无子任务形态）' : '拆解 → 终检',
                )]
            const tailEdges = leaves.map(leaf => edgeTo(
              dagNodePos(leaf), leaf.layer + 1, finalcheckBox, finalcheckSlot,
              finalcheckRunning ? 'tf-dag-edge-flow' : leaf.sub.status === 'done' ? 'tf-dag-edge-done' : '',
              `phase-tail-${leaf.sub.id}`,
              `${leaf.sub.title} → 终检`,
            ))
            const acceptEdge = edgeTo(
              finalcheckBox, finalcheckSlot, acceptBox, acceptSlot,
              phaseById.get('accept')?.status === 'done' ? 'tf-dag-edge-done' : '',
              'phase-accept',
              '终检 → 人工终批',
            )
            return [...headEdges, ...tailEdges, acceptEdge]
          })()}
          {layout.edges.map((edge, i) => {
            const target = nodeById.get(edge.to)
            if (target === undefined) return null
            const to = dagNodePos(target)
            if (edge.missing) {
              // 孤儿 dep：在目标的入口侧画一小段红虚线桩提示数据异常（跟随行方向）
              const entryRight = dagEntryRight(target.layer + 1)
              const y = to.y + DAG_NODE_H / 2
              return (
                <path
                  key={`edge-${i}`}
                  className="tf-dag-edge tf-dag-edge-missing"
                  d={entryRight
                    ? `M ${to.x + DAG_NODE_W + DAG_GAP_X / 2} ${y} L ${to.x + DAG_NODE_W + 6} ${y}`
                    : `M ${to.x - DAG_GAP_X / 2} ${y} L ${to.x - 6} ${y}`}
                >
                  <title>{`未知依赖 ${edge.from}（dep 指向的子任务不存在）`}</title>
                </path>
              )
            }
            const source = nodeById.get(edge.from)
            if (source === undefined) return null
            const from = dagNodePos(source)
            const exitRight = dagExitRight(source.layer + 1)
            const entryRight = dagEntryRight(target.layer + 1)
            const x1 = exitRight ? from.x + DAG_NODE_W : from.x
            const y1 = from.y + DAG_NODE_H / 2
            const x2 = entryRight ? to.x + DAG_NODE_W : to.x
            const y2 = to.y + DAG_NODE_H / 2
            const edgeClass =
              source.sub.status === 'done' ? 'tf-dag-edge-done'
              : target.sub.status === 'in-progress' && target.sub.sessionId !== undefined ? 'tf-dag-edge-flow'
              : ''
            return (
              <path
                key={`edge-${i}`}
                className={`tf-dag-edge ${edgeClass}`}
                d={dagEdgePath(x1, y1, x2, y2, exitRight, entryRight)}
                markerEnd={markerFor(edgeClass)}
              >
                <title>{`${source.sub.title} → ${target.sub.title}`}</title>
              </path>
            )
          })}
          {(() => {
            // —— 相位药丸节点（居中排版；状态色语言与子任务卡一致） ——
            const boxes: Array<{ phase: DagPhase; box: { x: number; y: number } }> = [
              { phase: phases[0]!, box: decomposeBox },
              { phase: phases[1]!, box: finalcheckBox },
              { phase: phases[2]!, box: acceptBox },
            ]
            return boxes.map(({ phase, box }) => (
              <g
                key={phase.id}
                className={`tf-dag-phase tf-dag-phase-${phase.status}${selected !== null && selected.kind === 'phase' && selected.id === phase.id ? ' tf-dag-selected' : ''}`}
                role="button"
                tabIndex={0}
                aria-label={`${phase.label}（${phase.line}），点击查看轨迹`}
                onClick={event => selectNode(event, () => setSelected({ kind: 'phase', id: phase.id }))}
                onKeyDown={event => selectNode(event, () => setSelected({ kind: 'phase', id: phase.id }))}
              >
                <title>{`${phase.label} · ${phase.line}（点击查看轨迹）`}</title>
                <rect x={box.x} y={box.y} width={DAG_NODE_W} height={DAG_NODE_H} rx={DAG_NODE_H / 2} />
                <text className="tf-dag-phase-label" x={box.x + DAG_NODE_W / 2} y={box.y + 26} textAnchor="middle">{phase.label}</text>
                <text className="tf-dag-sub" x={box.x + DAG_NODE_W / 2} y={box.y + 44} textAnchor="middle">{phase.line}</text>
              </g>
            ))
          })()}
          {layout.nodes.map(node => {
            const { x, y } = dagNodePos(node)
            const status = node.sub.status
            const line2 =
              node.wait?.kind === 'deps'
                ? `等依赖：${node.wait.blockers[0]}${node.wait.blockers.length > 1 ? ` 等 ${node.wait.blockers.length} 项` : ''}`
                : node.wait?.kind === 'wip'
                  ? '排队中（等并发空位）'
                  : subtaskStatusLabel(status)
            return (
              <g
                key={node.sub.id}
                className={`tf-dag-node tf-dag-node-${status}${selected !== null && selected.kind === 'sub' && selected.id === node.sub.id ? ' tf-dag-selected' : ''}`}
                role="button"
                tabIndex={0}
                aria-label={`子任务「${node.sub.title}」（${subtaskStatusLabel(status)}），点击查看轨迹`}
                onClick={event => selectNode(event, () => setSelected({ kind: 'sub', id: node.sub.id }))}
                onKeyDown={event => selectNode(event, () => setSelected({ kind: 'sub', id: node.sub.id }))}
              >
                <title>
                  {`${node.sub.title} · ${subtaskStatusLabel(status)}` +
                    (node.sub.round > 1 ? ` · 第 ${node.sub.round} 轮` : '') +
                    (node.wait?.kind === 'deps' ? ` · 等待：${node.wait.blockers.join('、')}` : '') +
                    '（点击查看轨迹）'}
                </title>
                <rect x={x} y={y} width={DAG_NODE_W} height={DAG_NODE_H} rx={10} />
                <circle cx={x + 14} cy={y + 17} r={4} />
                <text className="tf-dag-title" x={x + 26} y={y + 21}>{truncateForDag(node.sub.title, 22)}</text>
                <text className="tf-dag-sub" x={x + 14} y={y + 42}>{truncateForDag(line2, 26)}</text>
                {node.sub.round > 1 && (
                  <text className="tf-dag-round" x={x + DAG_NODE_W - 8} y={y + 16} textAnchor="end">{`R${node.sub.round}`}</text>
                )}
              </g>
            )
          })}
        </svg>
      </div>
      {selected === null
        ? <span className="tf-hint">点击图中节点（子任务卡 / 阶段药丸）查看它的执行轨迹；执行中的节点会实时滚动更新最新进度。</span>
        : <DagHistoryPanel task={task} selection={selected} />}
      <DagMetaBar task={task} selection={selected} />
    </div>
  )
}

/** 时长的人类可读形态（流程图底部信息栏的执行时间用）。 */
function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时 ${minutes % 60} 分`
  return `${Math.floor(hours / 24)} 天 ${hours % 24} 小时`
}

/** Token 数的人类可读形态（12.3k / 1.25M；流程图底部信息栏用）。 */
function formatTokens(count: number): string {
  if (!Number.isFinite(count) || count < 0) return '—'
  if (count < 1000) return `${count}`
  if (count < 1000 * 1000) return `${(count / 1000).toFixed(1)}k`
  return `${(count / (1000 * 1000)).toFixed(2)}M`
}

/** 流程图底部信息栏（2026-09-22）：一行展示当前选中节点 / 任务的基本信息。
 *  未选中节点 = 任务级概况；选中子任务 = 状态/轮次/会话/执行时间/模型/依赖；
 *  选中相位 = 相位状态与说明。数据全部来自 ledger 快照，纯投影。 */
function DagMetaBar({ task, selection }: { task: Task; selection: DagSelection | null }): JSX.Element {
  const items: Array<{ label: string; value: string }> = []
  if (selection === null) {
    items.push(
      { label: '子任务', value: `${task.subtasks.filter(s => s.status === 'done' || s.status === 'review').length}/${task.subtasks.length} 完成` },
      { label: '迭代', value: `第 ${task.round} 轮` },
      { label: '创建于', value: relativeTime(task.createdAt) },
      { label: '更新于', value: relativeTime(task.updatedAt) },
    )
  } else if (selection.kind === 'sub') {
    const sub = task.subtasks.find(s => s.id === selection.id)
    if (sub !== undefined) {
      // 执行时间从首次真正开工（第一条 to === 'in-progress' 的流转）算起，
      // 不含拆解编排期的等待（建卡/依赖排队不算执行）。
      const times = sub.history.map(event => event.at)
      const startedAt = sub.history.find(event => event.to === 'in-progress')?.at
      const running = sub.status === 'in-progress' && sub.sessionId !== undefined
      const end = running ? Date.now() : times.length > 0 ? Math.max(...times) : undefined
      const latestSession = sub.sessionId ?? sub.sessionIds[sub.sessionIds.length - 1]
      const model = latestSession !== undefined ? modelForSession(sub, latestSession) : undefined
      const usage = sub.tokenUsage
      items.push(
        { label: '状态', value: subtaskStatusLabel(sub.status) },
        { label: '轮次', value: `第 ${sub.round} 轮` },
        { label: '会话', value: `${sub.attempt} 次` },
        { label: '执行时间', value: startedAt !== undefined && end !== undefined && end >= startedAt ? `${formatDuration(end - startedAt)}${running ? '（进行中）' : ''}` : '—' },
        { label: 'Token', value: usage !== undefined ? `入 ${formatTokens(usage.inputTokens)} · 出 ${formatTokens(usage.outputTokens)}${usage.reasoningTokens !== undefined ? ` · 推理 ${formatTokens(usage.reasoningTokens)}` : ''}` : '—' },
        { label: '模型', value: model ?? '宿主默认' },
        { label: '依赖', value: sub.deps.length > 0 ? `${sub.deps.length} 项` : '无' },
      )
    } else {
      items.push({ label: '子任务', value: '已不存在' })
    }
  } else {
    const phase = dagPhases(task).find(p => p.id === selection.id)
    if (phase !== undefined) {
      items.push(
        { label: '相位', value: phase.label },
        { label: '状态', value: subtaskStatusLabelLike(phase.status) },
        { label: '说明', value: phase.line },
      )
    }
  }
  return (
    <div className="tf-dag-meta" role="status" aria-label="节点基本信息">
      {items.map(item => (
        <span className="tf-dag-meta-item" key={item.label}>
          <span className="tf-dag-meta-label">{item.label}</span>
          <span className="tf-dag-meta-value" title={item.value}>{item.value}</span>
        </span>
      ))}
    </div>
  )
}

/** 相位状态复用子任务状态色语言的展示名（DagPhase.status ∈ pending/in-progress/done/blocked/review）。 */
function subtaskStatusLabelLike(status: DagPhase['status']): string {
  return status === 'in-progress' ? '进行中' : status === 'done' ? '完成' : status === 'review' ? '待人' : status === 'blocked' ? '受阻' : '等待'
}

/** 节点轨迹面板（三期：历史内嵌流程图）：点选节点 → 下方升序时间线；
 *  执行中（子任务有会话 / 相位运行中）自动滚到底部，新进度便签实时追加。 */
function DagHistoryPanel({ task, selection }: { task: Task; selection: DagSelection }): JSX.Element | null {
  const sub = selection.kind === 'sub' ? task.subtasks.find(s => s.id === selection.id) : undefined
  const phase = selection.kind === 'phase' ? dagPhases(task).find(p => p.id === selection.id) : undefined
  const entries = selection.kind === 'sub'
    ? sub !== undefined ? subtaskTimeline(sub) : []
    : phaseTimeline(task, selection.id)
  const live = selection.kind === 'sub'
    ? sub !== undefined && sub.status === 'in-progress' && sub.sessionId !== undefined
    : phase?.status === 'in-progress'
  const title = selection.kind === 'sub'
    ? sub !== undefined ? `「${sub.title}」轨迹` : '子任务已不存在'
    : `${phase?.label ?? ''} · 记录`
  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    // 执行中钉住底部（新便签/新事件到达即跟随）；已完成时初次也落到底部（最新在末尾）。
    // scrollTop 赋值而非 scrollTo()：jsdom 未实现 element.scrollTo（渲染冒烟会炸）。
    const el = listRef.current
    if (el !== null) el.scrollTop = el.scrollHeight
  }, [entries.length, live, selection])
  if (selection.kind === 'sub' && sub === undefined) return null
  return (
    <div className="tf-dag-panel">
      <div className="tf-dag-panel-head">
        <span className="tf-section-title">{title}</span>
        {live
          ? <span className="tf-chip tf-chip-warn">执行中 · 实时滚动</span>
          : <span className="tf-chip">{entries.length} 条记录</span>}
      </div>
      <div className="tf-timeline" ref={listRef}>
        {entries.length === 0 && <span className="tf-hint">暂无记录。</span>}
        {entries.map(entry => (
          <TimelineRow key={entry.id} entry={entry} />
        ))}
      </div>
    </div>
  )
}

function SubtasksTab({ task }: { task: Task }): JSX.Element {
  return (
    <div className="tf-section">
      <span className="tf-section-title">子任务（{task.subtasks.filter(s => s.status === 'done' || s.status === 'review').length}/{task.subtasks.length} 完成）</span>
      <div className="tf-list">
        {task.subtasks.map((sub, i) => (
          <SubtaskItem key={sub.id} sub={sub} task={task} index={i} />
        ))}
      </div>
    </div>
  )
}

/** 子任务展示序号（S1/S2…）：编号类标记统一用它做前缀，避免各卡内部 AC-1 撞号。 */

function SubtaskItem({ sub, task, index }: { sub: Subtask; task: Task; index: number }): JSX.Element {
  const wait = subtaskWait(task, sub)
  return (
    <div className="tf-item">
      <div className="tf-item-head">
        <StatusDot status={sub.status} />
        <span className="tf-item-title">{sub.title}</span>
        <span className="tf-chip">S{index + 1}</span>
        <span className="tf-chip">{subtaskStatusLabel(sub.status)}</span>
        {wait?.kind === 'deps' && (
          <span className="tf-chip tf-chip-warn" title={`等待依赖完成：${wait.blockers.join('、')}`}>
            等依赖：{wait.blockers[0]}{wait.blockers.length > 1 ? ` 等 ${wait.blockers.length} 项` : ''}
          </span>
        )}
        {wait?.kind === 'wip' && <span className="tf-chip">排队中</span>}
        {sub.round > 1 && <span className="tf-chip">第 {sub.round} 轮</span>}
        {sub.attempt > 1 && <span className="tf-chip">attempt {sub.attempt}</span>}
      </div>
      {sub.detail.trim().length > 0 && <span className="tf-hint">{sub.detail}</span>}
      <div className="tf-section">
        {sub.acceptance.map((item, i) => (
          <div className="tf-ac" key={item.id}>
            <span className="tf-ac-id">S{index + 1}·AC-{i + 1}</span>
            <span>{item.text}</span>
          </div>
        ))}
      </div>
      {/* 会话裸 id 不再外显：对人有意义的轮次/次数已由上方 chip 承担；
          排障需要完整 id 时去 ledger.json / 宿主日志查。 */}
      {sub.progressNotes.length > 0 && (
        <span className="tf-hint">最近便签：{sub.progressNotes.at(-1)}</span>
      )}
    </div>
  )
}

// —— 验收工作台（FR-07 / §4.6，2026-09-11 语义：验收只对合同，过程归 AI）——

/** 验收标准 × 证据自检 的通过统计（任务级与子任务级共用）。 */
function checkStatsOf(acceptance: AcceptanceItem[], evidence: Evidence | undefined): { passed: number; total: number } {
  if (evidence === undefined) return { passed: 0, total: 0 }
  const checkById = new Map(evidence.selfCheck.map(check => [check.acceptanceId, check]))
  const total = acceptance.length
  const passed = acceptance.filter(item => checkById.get(item.id)?.verdict === 'pass').length
  return { passed, total }
}

/** 子任务维度的便捷包装。 */
function checkStats(sub: Subtask): { passed: number; total: number } {
  return checkStatsOf(sub.acceptance, sub.evidence)
}

/** 自检徽章语义色：全过=绿、全挂=红、部分=橙。 */
function checkBadgeClass(passed: number, total: number): string {
  if (total === 0) return 'mid'
  return passed === total ? 'ok' : passed === 0 ? 'bad' : 'mid'
}

function CheckBadge({ passed, total, mini }: { passed: number; total: number; mini?: boolean }): JSX.Element {
  return (
    <span className={`tf-checkbadge ${mini ? 'mini ' : ''}${checkBadgeClass(passed, total)}`}>
      自检 {passed}/{total}
    </span>
  )
}

/** 结论带（方案B，2026-09-11）：任务级判定面顶部——通过率 + 差额 + 进度条，
 *  整条语义底色（全过绿 / 全挂红 / 其余橙），一眼读出「过没过、差在哪」。
 *  正常只出现在已有任务级终检证据时（taskStats.total > 0 由调用方保证）。 */
function VerdictBanner({ passed, total, missingIds }: { passed: number; total: number; missingIds: string[] }): JSX.Element {
  const concerns = total - passed
  const cls = concerns === 0 ? 'allpass' : concerns === total ? 'allfail' : ''
  const pct = Math.round((passed / total) * 100)
  return (
    <div className={`tf-banner2${cls === '' ? '' : ` ${cls}`}`} role="status" aria-label={`自检 ${passed}/${total} 通过`}>
      <span className="tf-banner-rate">{passed}/{total}<small> 通过</small></span>
      <span className="tf-banner-mid">
        <span className="tf-banner-title">
          {concerns === 0 ? '整体交付满足合同，可直接终批' : `${concerns} 项未完全满足，建议在批语中点名后打回`}
        </span>
        <span className="tf-banner-bar"><i style={{ width: `${pct}%` }} aria-hidden="true" /></span>
        <span className="tf-banner-note">
          {concerns === 0
            ? '全量验收标准逐条核验通过'
            : `未完全通过的项：${missingIds.join('、')}——见下方色标清单`}
        </span>
      </span>
      <span className={`tf-verdict ${concerns === 0 ? 'tf-verdict-pass' : 'tf-verdict-partial'}`}>{concerns === 0 ? '达标' : '待补'}</span>
    </div>
  )
}

function ReviewTab({
  task,
  busy,
  act,
  transport,
}: {
  task: Task
  busy: boolean
  act: (action: Record<string, unknown>) => Promise<void>
  transport: TaskflowTransport
}): JSX.Element {
  const [comment, setComment] = useState('')
  const [procOpen, setProcOpen] = useState(false)
  const [openSubId, setOpenSubId] = useState<string | null>(null)
  const inReview = task.subtasks.filter(s => s.status === 'review')
  const canReject = inReview.length > 0
  const atLimit = task.maxRounds !== null && task.round + 1 > task.maxRounds
  const acceptance = task.contract.acceptance
  const taskEvidence = task.evidence
  const taskStats = checkStatsOf(acceptance, taskEvidence)
  const finalizing = task.finalizeSessionId !== undefined
  const triaging = task.triageSessionId !== undefined
  const taskCheckById = taskEvidence === undefined
    ? null
    : new Map(taskEvidence.selfCheck.map(check => [check.acceptanceId, check]))
  // 交付物预览（§4.5b）：验收台直接看产物本体，不用离开看板去翻文件
  const previewArtifact = useCallback(
    (path: string) => transport.getArtifactPreview(task.id, path),
    [transport, task.id],
  )

  return (
    <div className="tf-review">
      <div className="tf-review-scroll">
        {/* —— 任务级验收（人的判定面：只对合同，不对子任务；方案B 白卡判定面 + 结论带）—— */}
        <section className="tf-section tf-judge">
          <div className="tf-task-head">
            <span className="tf-section-title">任务验收（对照任务合同）</span>
            {taskEvidence !== undefined && taskStats.total > 0 && (
              <CheckBadge passed={taskStats.passed} total={taskStats.total} />
            )}
          </div>
          {taskEvidence !== undefined && taskStats.total > 0 && (
            <VerdictBanner
              passed={taskStats.passed}
              total={taskStats.total}
              missingIds={acceptance
                .filter(item => (taskCheckById?.get(item.id)?.verdict ?? 'fail') !== 'pass')
                .map(item => item.id)}
            />
          )}
          {taskEvidence !== undefined ? (
            <EvidenceView
              title="任务级终检（整体交付对照合同）"
              acceptance={acceptance}
              evidence={taskEvidence}
              headExtra={<span className="tf-chip tf-chip-mono">AI 终检</span>}
              previewArtifact={previewArtifact}
            />
          ) : finalizing ? (
            <span className="tf-hint">AI 终检中：正在对照任务级验收标准核验整体交付；完成后进入人工终批——你不需要逐个看子任务。</span>
          ) : task.status === 'review' && acceptance.length > 0 ? (
            <span className="tf-hint">
              本任务暂无任务级终检证据（存量任务）。子任务证据可作为验收材料，或
              <button type="button" className="tf-link-btn" disabled={busy} onClick={() => void act({ type: 'generateTaskEvidence' })}>补跑 AI 终检</button>
            </span>
          ) : (
            <span className="tf-hint">子任务执行中；全部完成后 AI 会先对照任务级验收标准做终检，再交给你终批。</span>
          )}
          {taskEvidence !== undefined && task.status === 'review' && (
            <span className="tf-hint">
              终检结论或交付物口径不对？
              <button type="button" className="tf-link-btn" disabled={busy} onClick={() => void act({ type: 'generateTaskEvidence' })}>重跑 AI 终检</button>
              （原任务级证据作废，重新核验并声明交付物）
            </span>
          )}
          {triaging && <span className="tf-hint">AI 正在根据批语定位需返工的子任务（其余子任务不会重跑）…</span>}
          {/* 无终检证据时（存量任务/兜底）标准清单独立成区作对照；有终检证据时由终检卡的
              「逐条自检」承担——验收标准只渲染一份（2026-09-11 方案B 去重） */}
          {taskEvidence === undefined && (
            <div className="tf-section">
              <span className="tf-section-title">任务级验收标准（{acceptance.length}）</span>
              {acceptance.length === 0 && <span className="tf-hint">（空 —— AI 拆解时会补全建议稿）</span>}
              {acceptance.map(item => (
                <div className="tf-ev-check" key={item.id}>
                  <span className="tf-ev-check-body">
                    <span className="tf-ev-check-ac">{item.text}</span>
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* —— 执行过程举证（AI 的过程留痕，非验收判定面）—— */}
        <section className="tf-section">
          <button type="button" className="tf-ev-sechead" aria-expanded={procOpen} onClick={() => setProcOpen(open => !open)}>
            <span className={`tf-ev-caret${procOpen ? ' open' : ''}`} aria-hidden="true">▶</span>
            <span className="tf-section-title">执行过程举证（{task.subtasks.length}）</span>
            <span className="tf-hint">AI 执行留痕，无需逐个验收；点开可查每个子任务的证据</span>
          </button>
          {procOpen && (
            <div className="tf-proc">
              {task.subtasks.map((sub, idx) => (
                <div className="tf-proc-item" key={sub.id}>
                  <button
                    type="button"
                    className="tf-proc-row"
                    aria-expanded={openSubId === sub.id}
                    onClick={() => setOpenSubId(id => (id === sub.id ? null : sub.id))}
                  >
                    <span className={`tf-ev-caret${openSubId === sub.id ? ' open' : ''}`} aria-hidden="true">▶</span>
                    <StatusDot status={sub.status} />
                    <span className="tf-proc-title">S{idx + 1} · {sub.title}</span>
                    {sub.evidence !== undefined && sub.acceptance.length > 0 && (
                      <ProcBadge sub={sub} />
                    )}
                  </button>
                  {openSubId === sub.id && (sub.evidence !== undefined
                    ? <EvidenceDetail key={sub.id} sub={sub} previewArtifact={previewArtifact} />
                    : <NoEvidencePanel sub={sub} no={idx + 1} />)}
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
      <footer className="tf-review-foot">
        {task.status === 'review' ? (
          <button
            type="button"
            className="tf-btn tf-btn-primary"
            disabled={busy}
            onClick={() => void act({ type: 'approveTask' })}
          >
            ✓ 验收通过（→ done）
          </button>
        ) : task.status === 'in-progress' && (inReview.length > 0 || triaging) ? (
          <span className="tf-hint">执行中：打回批语将由 AI 定位返工范围，无需选择子任务。</span>
        ) : (
          <span className="tf-hint">当前状态 {statusLabel(task.status)}，无待验收操作。</span>
        )}
        {(task.status === 'review' || (task.status === 'in-progress' && inReview.length > 0)) && (
          <>
            <textarea
              className="tf-textarea"
              aria-label="打回批语（必填，将原文注入下一轮执行）"
              placeholder="打回时必填：说清哪里不满足验收标准；AI 会据此定位需返工的子任务"
              value={comment}
              onChange={event => setComment(event.target.value)}
            />
            {atLimit ? (
              <>
                <span className="tf-chip tf-chip-warn">已达迭代上限（{task.round}/{task.maxRounds}）</span>
                <button type="button" className="tf-btn" disabled={busy} onClick={() => void act({ type: 'raiseMaxRounds', maxRounds: (task.maxRounds ?? 3) + 2 })}>提高上限并打回</button>
              </>
            ) : (
              <button
                type="button"
                className="tf-btn tf-btn-danger"
                disabled={busy || !canReject || comment.trim().length === 0}
                onClick={() => void act({ type: 'rejectSubtask', comment })}
              >
                ✗ 打回并继续迭代
              </button>
            )}
          </>
        )}
      </footer>
    </div>
  )
}

/** 过程清单行的小徽章（自检通过率）。 */
function ProcBadge({ sub }: { sub: Subtask }): JSX.Element {
  const stats = checkStats(sub)
  return <CheckBadge passed={stats.passed} total={stats.total} mini />
}

/** 未举证子任务的详情占位：给足上下文（说明 + 子任务验收标准），点开任何一行都有内容。 */
function NoEvidencePanel({ sub, no }: { sub: Subtask; no?: number }): JSX.Element {
  return (
    <div className="tf-item">
      <div className="tf-item-head">
        <StatusDot status={sub.status} />
        <span className="tf-item-title">{sub.title}</span>
        {no !== undefined && <span className="tf-chip">S{no}</span>}
        <span className="tf-chip">{subtaskStatusLabel(sub.status)}</span>
        {sub.round > 1 && <span className="tf-chip">第 {sub.round} 轮</span>}
      </div>
      {sub.detail.trim().length > 0 && <span className="tf-hint">{sub.detail}</span>}
      <div className="tf-section">
        <span className="tf-section-title">子任务验收标准</span>
        {sub.acceptance.map((item, i) => (
          <div className="tf-ac" key={item.id}>
            <span className="tf-ac-id">{no !== undefined ? `S${no}·` : ''}AC-{i + 1}</span>
            <span>{item.text}</span>
          </div>
        ))}
      </div>
      <span className="tf-hint">该子任务尚未提交证据；执行会话完成时提交，通过三要素校验后出现在这里。</span>
    </div>
  )
}

/**
 * 证据视图（分层：交付物先行 → 判定 → 自检前置 → 摘要限高 → 验证折叠）。
 * 任务级终检卡与子任务证据卡共用；key 挂在调用方：切换对象时折叠状态整体重置。
 */
function EvidenceView({
  title,
  acceptance,
  evidence,
  round,
  status,
  headExtra,
  previewArtifact,
}: {
  title: string
  acceptance: AcceptanceItem[]
  evidence: Evidence
  round?: number
  status?: Subtask['status'] | Task['status']
  headExtra?: JSX.Element
  /** 交付物预览口（§4.5b）；缺省 = 只展示声明不提供预览。 */
  previewArtifact?: (path: string) => Promise<ArtifactPreview>
}): JSX.Element {
  const stats = checkStatsOf(acceptance, evidence)
  const checkById = new Map(evidence.selfCheck.map(check => [check.acceptanceId, check]))
  const hasFailedChecks = stats.total === 0 || stats.passed < stats.total
  // hooks 必须先于条件返回；evidence 缺失时折叠态按「无失败」初始化即可
  const [checksOpen, setChecksOpen] = useState(hasFailedChecks)
  const summaryLong = evidence.changesSummary.length > 160
  const [summaryOpen, setSummaryOpen] = useState(false)
  const [openVerify, setOpenVerify] = useState<Record<number, boolean>>({})
  const hasArtifacts = (evidence.artifacts?.length ?? 0) > 0

  return (
    <article className="tf-ev">
      <div className="tf-ev-head">
        {status !== undefined && <StatusDot status={status} />}
        <span className="tf-ev-title">{title}</span>
        {headExtra}
        {stats.total > 0 && <CheckBadge passed={stats.passed} total={stats.total} />}
        {round !== undefined && round > 1 && <span className="tf-chip">第 {round} 轮证据</span>}
      </div>

      {hasArtifacts && (
        <ArtifactsBlock artifacts={evidence.artifacts ?? []} previewArtifact={previewArtifact} />
      )}

      <section className="tf-ev-section">
        <button type="button" className="tf-ev-sechead" aria-expanded={checksOpen} onClick={() => setChecksOpen(open => !open)}>
          <span className={`tf-ev-caret${checksOpen ? ' open' : ''}`} aria-hidden="true">▶</span>
          <span className="tf-section-title">逐条自检（对照验收标准）</span>
          {hasFailedChecks
            ? <span className="tf-verdict tf-verdict-fail">{stats.passed}/{stats.total} 通过</span>
            : <span className="tf-verdict tf-verdict-pass">全部通过</span>}
        </button>
        {checksOpen && (
          <div className="tf-evidence-checks">
            {acceptance.map(item => {
              const check = checkById.get(item.id)
              const verdict = check?.verdict ?? 'fail'
              return (
                <div className={`tf-ev-check tf-ev-check-${verdict}`} key={item.id}>
                  <span className={`tf-verdict tf-verdict-${verdict}`}>{check?.verdict ?? '缺失'}</span>
                  <span className="tf-ev-check-body">
                    <span className="tf-ev-check-ac">{item.text}</span>
                    <span className="tf-ev-check-note">{check?.note ?? '（缺自检条目）'}</span>
                  </span>
                </div>
              )
            })}
          </div>
        )}
      </section>

      <section className="tf-ev-section">
        <div className="tf-ev-sechead">
          <span className="tf-section-title">变更摘要</span>
          {summaryLong && (
            <button type="button" className="tf-link-btn" onClick={() => setSummaryOpen(open => !open)}>
              {summaryOpen ? '收起' : '展开全文'}
            </button>
          )}
        </div>
        <span className={summaryOpen ? 'tf-ev-summary' : 'tf-ev-summary tf-clamp'}>{evidence.changesSummary}</span>
        {evidence.refs.diffSummary !== undefined && (
          <span className="tf-evidence-diff">{evidence.refs.diffSummary}</span>
        )}
      </section>

      <section className="tf-ev-section">
        <span className="tf-section-title">验证记录（{evidence.verification.length}）</span>
        {evidence.verification.map((record, index) => {
          const open = openVerify[index] ?? !record.passed
          return (
            <div className="tf-ev-verify" key={index}>
              <button
                type="button"
                className="tf-ev-sechead"
                aria-expanded={open}
                onClick={() => setOpenVerify(map => ({ ...map, [index]: !open }))}
              >
                <span className={`tf-ev-caret${open ? ' open' : ''}`} aria-hidden="true">▶</span>
                <span className={`tf-verdict tf-verdict-${record.passed ? 'pass' : 'fail'}`}>{record.passed ? '通过' : '失败'}</span>
                <span className="tf-ev-verify-label">{record.label}</span>
              </button>
              {open && <pre className="tf-verify">{record.output}</pre>}
            </div>
          )
        })}
      </section>
    </article>
  )
}

/** 子任务证据卡 = EvidenceView + 会话/模型留痕。 */
function EvidenceDetail({ sub, previewArtifact }: { sub: Subtask; previewArtifact?: (path: string) => Promise<ArtifactPreview> }): JSX.Element {
  const evidence = sub.evidence
  if (evidence === undefined) return <></>
  return (
    <>
      <EvidenceView
        title={sub.title}
        acceptance={sub.acceptance}
        evidence={evidence}
        previewArtifact={previewArtifact}
        round={sub.round}
        status={sub.status}
      />
      <span className="tf-hint">
        产出：第 {sub.round} 轮执行{sub.attempt > 1 ? `（重试 attempt ${sub.attempt}）` : ''}
        {modelForSession(sub, evidence.refs.sessionId) !== undefined && (
          <> · 模型 <span className="tf-chip tf-chip-mono">{modelForSession(sub, evidence.refs.sessionId)}</span></>
        )}
      </span>
    </>
  )
}

// —— 历史时间线（FR-09；2026-09-21 三期：独立 tab 退役，TimelineRow 由流程图
//    节点轨迹面板复用）——

function TimelineRow({ entry }: { entry: TimelineEntry }): JSX.Element {
  const time = new Date(entry.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const date = new Date(entry.at).toLocaleDateString([], { month: 'numeric', day: 'numeric' })
  const isReject = entry.detail !== undefined && entry.label.includes('被打回') === false && /打回|批语/.test(entry.detail)
  return (
    <div className="tf-tl-entry">
      <span className="tf-tl-time">{date} {time}</span>
      <div>
        <div className="tf-tl-label">
          <span className="tf-tl-actor">{actorLabel(entry.actor)}</span>
          <span style={{ fontWeight: entry.isTransition ? 600 : 400 }}>{entry.label}</span>
          {entry.model !== undefined && <span className="tf-chip tf-chip-mono" title="会话模型">{entry.model}</span>}
        </div>
        {entry.detail !== undefined && <div className={`tf-tl-detail${isReject ? ' tf-tl-reject' : ''}`}>{entry.detail}</div>}
      </div>
    </div>
  )
}

// —— 拆解记录（FR-03 留痕）——

function DecomposeTab({ task }: { task: Task }): JSX.Element {
  return (
    <div className="tf-section">
      <span className="tf-section-title">拆解记录</span>
      {task.decomposeSessionIds.length === 0 ? (
        <span className="tf-hint">尚未拆解。</span>
      ) : task.decomposeSessionIds.length === 1 ? (
        <span className="tf-hint">AI 拆解 1 次；完整对话可在宿主会话列表中回放。</span>
      ) : (
        <span className="tf-hint">AI 拆解 {task.decomposeSessionIds.length} 次（含重拆）；完整对话可在宿主会话列表中回放。</span>
      )}
    </div>
  )
}

// —— 通用 ——

function StatusDot({ status }: { status: Task['status'] | Subtask['status'] }): JSX.Element {
  const dot =
    status === 'done' ? 'tf-dot-green'
    : status === 'review' ? 'tf-dot-blue'
    : status === 'blocked' || status === 'rejected' ? 'tf-dot-red'
    : status === 'in-progress' || status === 'decomposing' ? 'tf-dot-amber'
    : 'tf-dot-gray'
  return <span className={`tf-status-dot ${dot}`} aria-hidden="true" />
}

// —— 交付物（§4.5b，2026-09-11）：产物本体进验收台 ——
// 预览内容为 AI 产出的文件文本，一律走 MarkdownView（React 转义，无 HTML 注入面）。

type PreviewState =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'done'; data: ArtifactPreview }

/** 交付物区块（产物清单 + 只读预览）。终检卡内与产物页共用。 */
function ArtifactsBlock({
  artifacts,
  previewArtifact,
}: {
  artifacts: Artifact[]
  previewArtifact?: (path: string) => Promise<ArtifactPreview>
}): JSX.Element {
  const [open, setOpen] = useState<Record<string, boolean>>({})
  return (
    <div className="tf-ev-section tf-artifacts" data-testid="deliverables">
      <div className="tf-ev-sechead">
        <span className="tf-section-title">交付物（{artifacts.length}）</span>
        <span className="tf-hint" style={{ marginLeft: 'auto' }}>产物本体——最需要看的东西，点「预览」直接查看</span>
      </div>
      {artifacts.map((artifact, index) => (
        <ArtifactRow
          key={`${artifact.path}-${index}`}
          artifact={artifact}
          open={open[artifact.path] ?? false}
          preview={previewArtifact}
          onToggle={() => setOpen(map => ({ ...map, [artifact.path]: !(map[artifact.path] ?? false) }))}
        />
      ))}
    </div>
  )
}

/** 产物页（2026-09-12）：任务级交付物独立成页——验收完成（done）后默认落点。
 *  验收页专注验收；产物不在验收里翻。口径同 §4.5b：只收录验收人终审要看的最终产物。 */
function DeliverablesTab({ task, transport }: { task: Task; transport: TaskflowTransport }): JSX.Element {
  const previewArtifact = useCallback(
    (path: string) => transport.getArtifactPreview(task.id, path),
    [transport, task.id],
  )
  const artifacts = task.evidence?.artifacts ?? []
  return (
    <div className="tf-section">
      <span className="tf-section-title">产物（任务级交付物{artifacts.length > 0 ? ` · ${artifacts.length}` : ''}）</span>
      {artifacts.length === 0 ? (
        <span className="tf-hint">
          {task.evidence === undefined
            ? '尚无任务级终检产物。（存量任务未跑终检，可到验收页「补跑 AI 终检」后回来看。）'
            : '终检未声明文件交付物。'}
        </span>
      ) : (
        <>
          <ArtifactsBlock artifacts={artifacts} previewArtifact={previewArtifact} />
          <span className="tf-hint">产物由任务级终检声明（§4.5b 口径：只收录验收人终审要看的最终产物）；预览只读，≤256KiB 截断。</span>
        </>
      )}
    </div>
  )
}

/** 单条交付物：路径 + 说明 + 核验方式 + 复制路径，可展开只读预览。 */
function ArtifactRow({
  artifact,
  open,
  onToggle,
  preview,
}: {
  artifact: Artifact
  open: boolean
  onToggle: () => void
  preview?: (path: string) => Promise<ArtifactPreview>
}): JSX.Element {
  const [state, setState] = useState<PreviewState | null>(null)
  const [copied, setCopied] = useState(false)

  const toggle = (): void => {
    onToggle()
    if (open || preview === undefined) return // 即将从 open → closed，或无预览口
    if (state !== null) return
    setState({ phase: 'loading' })
    preview(artifact.path)
      .then(data => setState({ phase: 'done', data }))
      .catch((error: unknown) => setState({ phase: 'error', message: error instanceof Error ? error.message : String(error) }))
  }

  const copy = (): void => {
    void navigator.clipboard?.writeText(artifact.path)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="tf-artifact">
      <div className="tf-artifact-row">
        <span className="tf-artifact-icon" aria-hidden="true">📄</span>
        <span className="tf-artifact-path" title={artifact.path}>{shortArtifactPath(artifact.path)}</span>
        <button type="button" className="tf-link-btn" onClick={copy}>{copied ? '已复制' : '复制路径'}</button>
        {preview !== undefined && (
          <button type="button" className="tf-link-btn" aria-expanded={open} onClick={toggle}>
            {open ? '收起预览' : '预览'}
          </button>
        )}
      </div>
      <div className="tf-artifact-meta">
        {artifact.description !== undefined && <span className="tf-artifact-desc">{artifact.description}</span>}
        {artifact.howVerified !== undefined && <span className="tf-artifact-verified">核验：{artifact.howVerified}</span>}
      </div>
      {open && (
        <div className="tf-artifact-preview">
          {state?.phase === 'loading' && <span className="tf-hint">加载预览…</span>}
          {state?.phase === 'error' && <span className="tf-hint">预览失败：{state.message}</span>}
          {state?.phase === 'done' && state.data.binary && (
            <span className="tf-hint">二进制文件（{formatBytes(state.data.size)}），不支持文本预览。</span>
          )}
          {state?.phase === 'done' && !state.data.binary && (
            <>
              {(state.data.truncated || state.data.size > 0) && (
                <div className="tf-artifact-previewbar">
                  {formatBytes(state.data.size)}
                  {state.data.truncated && ' · 仅预览前 256KB'}
                </div>
              )}
              <div className="tf-md">{renderBlocks(parseMarkdown(state.data.content))}</div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
