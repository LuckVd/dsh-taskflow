/**
 * 看板主组件（FR-10/11，US-14 三态完整）。
 *
 * @module dsh-taskflow/client
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { TaskflowTransport } from './api.ts'
import {
  actorLabel,
  boardGroups,
  filterTasks,
  formatBytes,
  mergedTimeline,
  modelForSession,
  pendingApprovalCount,
  pendingApprovalsOf,
  progressRatio,
  relativeTime,
  reviewBadgeCount,
  shortArtifactPath,
  statusLabel,
  subtaskStatusLabel,
  subtaskWait,
} from './view.ts'
import type { CardSummary, PendingApprovalView, TimelineEntry } from './view.ts'
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
import type { Artifact, ArtifactPreview, DispatchResult, EngineState } from '../protocol/types.ts'
import type { AcceptanceItem, Evidence, Subtask, Task } from '../protocol/types.ts'

type TabId = 'contract' | 'subtasks' | 'review' | 'deliverables' | 'history' | 'decompose'

const TABS: ReadonlyArray<{ id: TabId; title: string }> = [
  { id: 'contract', title: '合同' },
  { id: 'subtasks', title: '子任务' },
  { id: 'review', title: '验收' },
  { id: 'deliverables', title: '产物' },
  { id: 'history', title: '历史' },
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
        <CreateDrawer
          onClose={() => setCreateOpen(false)}
          dispatch={dispatch}
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

function CreateDrawer({
  onClose,
  dispatch,
}: {
  onClose: () => void
  dispatch: (action: Record<string, unknown>) => Promise<DispatchResult>
}): JSX.Element {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [objective, setObjective] = useState('')
  const [acceptanceText, setAcceptanceText] = useState('')
  /** 执行模式（§7.1b）：默认完全权限（用户拍板 D1），映射为 pins 两轴组合。 */
  const [mode, setMode] = useState<'auto' | 'approval'>('auto')
  const [autoStart, setAutoStart] = useState(true)
  /** 迭代上限（留空 = 不限：任务一直跑到人工验收为止）。 */
  const [maxRounds, setMaxRounds] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    const acceptance = acceptanceText
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0)
      .map(text => ({ text }))
    const rounds = maxRounds.trim() === '' ? null : Math.min(99, Math.max(1, Number.parseInt(maxRounds, 10)))
    const result = await dispatch({
      type: 'createTask',
      title,
      description,
      acceptance: acceptance.length > 0 ? acceptance : undefined,
      ...(objective.trim().length > 0 ? { objective: objective.trim() } : {}),
      ...(rounds === null ? {} : { maxRounds: rounds }),
      pins: {
        permission: mode === 'auto' ? 'workspace-write' : 'read-only',
        executionMode: mode,
      },
      autoStart,
    })
    setBusy(false)
    if (result.ok) onClose()
    else setError(result.error ?? '创建失败')
  }

  return (
    <Drawer title="新建任务" onClose={onClose}>
      <div className="tf-form">
        <div className="tf-field">
          <label htmlFor="tf-title">标题 *</label>
          <input id="tf-title" className="tf-input" maxLength={120} placeholder="一句话说清要做什么" value={title} onChange={e => setTitle(e.target.value)} />
        </div>
        <div className="tf-field">
          <label htmlFor="tf-desc">描述 *（AI 的主要输入）</label>
          <textarea id="tf-desc" className="tf-textarea" value={description} onChange={e => setDescription(e.target.value)} placeholder="把你的诉求写清楚；验收标准可以不给，AI 拆解时会补全建议稿" />
        </div>
        <div className="tf-field">
          <label htmlFor="tf-obj">目标（可选，缺省用标题）</label>
          <input id="tf-obj" className="tf-input" value={objective} onChange={e => setObjective(e.target.value)} />
        </div>
        <div className="tf-field">
          <label htmlFor="tf-ac">验收标准（可选，每行一条；留空由 AI 补全）</label>
          <textarea id="tf-ac" className="tf-textarea" value={acceptanceText} onChange={e => setAcceptanceText(e.target.value)} placeholder={'例如：\n全部测试通过\nREADME 更新使用说明'} />
        </div>
        <div className="tf-field">
          <label>执行模式</label>
          <div className="tf-mode-row" role="radiogroup" aria-label="执行模式">
            <label className={`tf-mode-card${mode === 'auto' ? ' active' : ''}`}>
              <input type="radio" name="tf-exec-mode" checked={mode === 'auto'} onChange={() => setMode('auto')} />
              <span className="tf-mode-title">🔓 完全权限</span>
              <span className="tf-mode-desc">AI 自动执行，工具提权自动放行，全程不打扰</span>
            </label>
            <label className={`tf-mode-card${mode === 'approval' ? ' active' : ''}`}>
              <input type="radio" name="tf-exec-mode" checked={mode === 'approval'} onChange={() => setMode('approval')} />
              <span className="tf-mode-title">🔒 需要审批</span>
              <span className="tf-mode-desc">只读执行；写操作逐次通知你裁决</span>
            </label>
          </div>
          {mode === 'auto'
            ? <span className="tf-hint">⚠️ 完全权限：AI 的提权请求（含高危操作）将自动放行、不再询问，请确认任务目标与工作区可信。</span>
            : <span className="tf-hint">审批模式：提权请求会出现在全局通知栏，可在看板中「完全放行」或「拒绝」。</span>}
        </div>
        <div className="tf-field">
          <label htmlFor="tf-max-rounds">迭代上限（可选，留空 = 不限）</label>
          <input
            id="tf-max-rounds"
            className="tf-input"
            inputMode="numeric"
            placeholder="不限（默认：跑到你验收为止）"
            value={maxRounds}
            onChange={e => setMaxRounds(e.target.value.replace(/[^\d]/g, ''))}
          />
          <span className="tf-hint">打回迭代超过上限时任务会暂停等你裁决；留空则一直迭代，直到验收通过或你取消。</span>
        </div>
        <div className="tf-field">
          <label>
            <input type="checkbox" checked={autoStart} onChange={e => setAutoStart(e.target.checked)} /> 拆解后自动开工
          </label>
        </div>
        {error !== null && <div className="tf-banner" role="alert">{error}</div>}
        <div className="tf-actions">
          <button type="button" className="tf-btn tf-btn-primary" disabled={busy || title.trim().length === 0 || description.trim().length === 0} onClick={() => void submit()}>
            {busy ? '创建中…' : '创建并开始拆解'}
          </button>
          <button type="button" className="tf-btn" onClick={onClose}>取消</button>
        </div>
      </div>
    </Drawer>
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
  // 默认落点（2026-09-12 口径）：review = 等终批，落验收页（验收页专注验收）；done =
  // 验收完成，落「产物」页（不用再进验收页翻产物）；其余状态从合同看起。
  const [tab, setTab] = useState<TabId>(task.status === 'review' ? 'review' : task.status === 'done' ? 'deliverables' : 'contract')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dialogRef = useRef<HTMLElement>(null)
  useDialogA11y(dialogRef, onClose)
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
        {/* 验收 tab 是填充式工作台（内部自带滚动与吸底操作），其余 tab 走普通滚动 */}
        <div className={tab === 'review' ? 'tf-modal-body tf-modal-body-fill' : 'tf-modal-body'}>
          {error !== null && <div className="tf-banner" role="alert">{error}</div>}
          <ApprovalSection task={task} busy={busy} act={act} focusApprovalId={focusApprovalId} />
          {tab === 'contract' && <ContractTab task={task} />}
          {tab === 'subtasks' && <SubtasksTab task={task} />}
          {tab === 'review' && <ReviewTab task={task} busy={busy} act={act} transport={transport} />}
          {tab === 'deliverables' && <DeliverablesTab task={task} transport={transport} />}
          {tab === 'history' && <HistoryTab task={task} />}
          {tab === 'decompose' && <DecomposeTab task={task} />}
        </div>
        <footer className="tf-modal-foot">
          <TaskActions task={task} busy={busy} act={act} />
        </footer>
      </aside>
    </div>
  )
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
    <div className="tf-actions">
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

function ContractTab({ task }: { task: Task }): JSX.Element {
  const refined = task.contract.sourceOfAcceptance === 'ai-refined' && task.contract.originalHumanAcceptance !== undefined
  return (
    <>
      <div className="tf-section">
        <span className="tf-section-title">合同（目标 · 验收 · 钉脚）</span>
        <dl className="tf-kv">
          <dt>目标</dt>
          <dd>{task.contract.objective}</dd>
          <dt>验收来源</dt>
          <dd>{task.contract.sourceOfAcceptance === 'human' ? '用户手写' : task.contract.sourceOfAcceptance === 'ai-drafted' ? 'AI 建议稿' : 'AI 细化（保留原文对照）'}</dd>
          <dt>迭代上限</dt>
          <dd>{task.maxRounds === null ? '不限' : task.maxRounds}（当前第 {task.round} 轮）</dd>
          <dt>权限</dt>
          <dd>
            {task.contract.pins.permission}
            {!task.permissionConfirmed && ' · 需确认'}
          </dd>
        </dl>
      </div>
      <AcceptanceList items={task.contract.acceptance} title="任务级验收标准" />
      {refined && <AcceptanceList items={task.contract.originalHumanAcceptance ?? []} title="用户原文（对照视图）" />}
    </>
  )
}

function AcceptanceList({ items, title }: { items: AcceptanceItem[]; title: string }): JSX.Element {
  return (
    <div className="tf-section">
      <span className="tf-section-title">{title}</span>
      {items.length === 0 ? (
        <span className="tf-hint">（空 —— AI 拆解时会补全建议稿）</span>
      ) : (
        items.map(item => (
          <div className="tf-ac" key={item.id}>
            <span className="tf-ac-id">{item.id}</span>
            <span>{item.text}</span>
          </div>
        ))
      )}
    </div>
  )
}

function SubtasksTab({ task }: { task: Task }): JSX.Element {
  return (
    <div className="tf-section">
      <span className="tf-section-title">子任务（{task.subtasks.filter(s => s.status === 'done' || s.status === 'review').length}/{task.subtasks.length} 完成）</span>
      <div className="tf-list">
        {task.subtasks.map(sub => (
          <SubtaskItem key={sub.id} sub={sub} task={task} />
        ))}
      </div>
    </div>
  )
}

function SubtaskItem({ sub, task }: { sub: Subtask; task: Task }): JSX.Element {
  const wait = subtaskWait(task, sub)
  return (
    <div className="tf-item">
      <div className="tf-item-head">
        <StatusDot status={sub.status} />
        <span className="tf-item-title">{sub.title}</span>
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
        {sub.acceptance.map(item => (
          <div className="tf-ac" key={item.id}>
            <span className="tf-ac-id">{item.id}</span>
            <span>{item.text}</span>
          </div>
        ))}
      </div>
      {sub.sessionId !== undefined && (
        <span className="tf-hint">
          会话：<button type="button" className="tf-session-link" title="复制会话 id" onClick={() => void navigator.clipboard?.writeText(sub.sessionId ?? '')}>{sub.sessionId}</button>
        </span>
      )}
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
              {task.subtasks.map(sub => (
                <div className="tf-proc-item" key={sub.id}>
                  <button
                    type="button"
                    className="tf-proc-row"
                    aria-expanded={openSubId === sub.id}
                    onClick={() => setOpenSubId(id => (id === sub.id ? null : sub.id))}
                  >
                    <span className={`tf-ev-caret${openSubId === sub.id ? ' open' : ''}`} aria-hidden="true">▶</span>
                    <StatusDot status={sub.status} />
                    <span className="tf-proc-title">{sub.title}</span>
                    {sub.evidence !== undefined && sub.acceptance.length > 0 && (
                      <ProcBadge sub={sub} />
                    )}
                  </button>
                  {openSubId === sub.id && (sub.evidence !== undefined
                    ? <EvidenceDetail key={sub.id} sub={sub} previewArtifact={previewArtifact} />
                    : <NoEvidencePanel sub={sub} />)}
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
function NoEvidencePanel({ sub }: { sub: Subtask }): JSX.Element {
  return (
    <div className="tf-item">
      <div className="tf-item-head">
        <StatusDot status={sub.status} />
        <span className="tf-item-title">{sub.title}</span>
        <span className="tf-chip">{subtaskStatusLabel(sub.status)}</span>
        {sub.round > 1 && <span className="tf-chip">第 {sub.round} 轮</span>}
      </div>
      {sub.detail.trim().length > 0 && <span className="tf-hint">{sub.detail}</span>}
      <div className="tf-section">
        <span className="tf-section-title">子任务验收标准</span>
        {sub.acceptance.map(item => (
          <div className="tf-ac" key={item.id}>
            <span className="tf-ac-id">{item.id}</span>
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
        产出会话：{evidence.refs.sessionId}
        {modelForSession(sub, evidence.refs.sessionId) !== undefined && (
          <> · 模型 <span className="tf-chip tf-chip-mono">{modelForSession(sub, evidence.refs.sessionId)}</span></>
        )}
      </span>
    </>
  )
}

// —— 历史时间线（FR-09）——

function HistoryTab({ task }: { task: Task }): JSX.Element {
  const entries = mergedTimeline(task)
  return (
    <div className="tf-section">
      <span className="tf-section-title">状态时间线（谁 · 何时 · 从哪到哪 · 为什么）</span>
      <div className="tf-timeline">
        {entries.map(entry => (
          <TimelineRow key={entry.id} entry={entry} />
        ))}
      </div>
    </div>
  )
}

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
      <span className="tf-section-title">拆解会话</span>
      {task.decomposeSessionIds.length === 0 ? (
        <span className="tf-hint">尚未拆解。</span>
      ) : (
        task.decomposeSessionIds.map((sessionId, index) => (
          <div className="tf-ac" key={sessionId}>
            <span className="tf-ac-id">#{index + 1}</span>
            <button type="button" className="tf-session-link" title="复制会话 id" onClick={() => void navigator.clipboard?.writeText(sessionId)}>{sessionId}</button>
          </div>
        ))
      )}
      <span className="tf-hint">拆解会话的完整对话可在宿主会话列表中回放。</span>
    </div>
  )
}

// —— 通用 ——

function Drawer({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }): JSX.Element {
  return (
    <div className="tf-overlay" onClick={event => { if (event.target === event.currentTarget) onClose() }}>
      <aside className="tf-drawer" role="dialog" aria-label={title}>
        <header className="tf-drawer-head">
          <span className="tf-drawer-title">{title}</span>
          <button type="button" className="tf-icon-btn" onClick={onClose} aria-label="关闭">✕</button>
        </header>
        <div className="tf-drawer-body">{children}</div>
      </aside>
    </div>
  )
}

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
