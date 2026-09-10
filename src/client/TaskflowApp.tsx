/**
 * 看板主组件（FR-10/11，US-14 三态完整）。
 *
 * @module dsh-taskflow/client
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { TaskflowTransport } from './api.ts'
import {
  actorLabel,
  boardGroups,
  filterTasks,
  mergedTimeline,
  progressRatio,
  relativeTime,
  reviewBadgeCount,
  statusLabel,
  subtaskStatusLabel,
} from './view.ts'
import type { CardSummary, TimelineEntry } from './view.ts'
import type { DispatchResult, EngineState } from '../protocol/types.ts'
import type { AcceptanceItem, Subtask, Task } from '../protocol/types.ts'

type TabId = 'contract' | 'subtasks' | 'review' | 'history' | 'decompose'

const TABS: ReadonlyArray<{ id: TabId; title: string }> = [
  { id: 'contract', title: '合同' },
  { id: 'subtasks', title: '子任务' },
  { id: 'review', title: '验收' },
  { id: 'history', title: '历史' },
  { id: 'decompose', title: '拆解记录' },
]

function newRequestId(): string {
  return `ui-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export function TaskflowApp({ transport, onClose }: { transport: TaskflowTransport; onClose?: () => void }): JSX.Element {
  const [state, setState] = useState<EngineState | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [sseUp, setSseUp] = useState(true)
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'review' | 'blocked' | 'done'>('all')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const refreshSeq = useRef(0)

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

  const tasks = state?.ledger.tasks ?? []
  const filtered = useMemo(() => filterTasks(tasks, { query, status: statusFilter }), [tasks, query, statusFilter])
  const groups = useMemo(() => boardGroups(filtered), [filtered])
  const reviewCount = reviewBadgeCount(tasks)
  const selected = tasks.find(t => t.id === selectedId) ?? null

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
        <button type="button" className="tf-btn tf-btn-primary" onClick={() => setCreateOpen(true)}>+ 新建任务</button>
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
                  <TaskCard key={card.task.id} card={card} onOpen={() => setSelectedId(card.task.id)} />
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
        <DetailDrawer
          task={selected}
          onClose={() => setSelectedId(null)}
          dispatch={dispatch}
          onRefresh={refresh}
        />
      )}
    </div>
  )
}

// —— 卡片 ——

function TaskCard({ card, onOpen }: { card: CardSummary; onOpen: () => void }): JSX.Element {
  const { task } = card
  const blocked = task.status === 'blocked'
  const running = task.status === 'decomposing' || task.status === 'in-progress'
  return (
    <button
      type="button"
      role="listitem"
      className="tf-card"
      data-status={task.status}
      onClick={onOpen}
      title={task.description !== '' ? task.description : task.title}
      aria-label={`打开任务 ${task.title}`}
    >
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
        {card.awaitingHuman === 'permission' && <span className="tf-chip tf-chip-warn">执行需确认</span>}
        {card.awaitingHuman === 'review' && <span className="tf-chip tf-chip-warn">等验收</span>}
        {blocked && card.blockedReason !== undefined && (
          <span className="tf-chip" title={card.blockedReason}>受阻</span>
        )}
        <span className="tf-time">{relativeTime(card.lastActivity)}</span>
      </span>
    </button>
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
  const [permission, setPermission] = useState('read-only')
  const [autoStart, setAutoStart] = useState(true)
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
    const result = await dispatch({
      type: 'createTask',
      title,
      description,
      acceptance: acceptance.length > 0 ? acceptance : undefined,
      ...(objective.trim().length > 0 ? { objective: objective.trim() } : {}),
      pins: { permission },
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
          <label htmlFor="tf-perm">执行权限</label>
          <select id="tf-perm" className="tf-select" value={permission} onChange={e => setPermission(e.target.value)}>
            <option value="read-only">read-only（默认）</option>
            <option value="workspace-write">workspace-write</option>
            <option value="danger-full-access">danger-full-access</option>
          </select>
          {permission !== 'read-only' && <span className="tf-hint">⚠️ 高于会话默认权限：首次执行前需在详情页确认。</span>}
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

// —— 详情抽屉（FR-11 五区）——

function DetailDrawer({
  task,
  onClose,
  dispatch,
  onRefresh,
}: {
  task: Task
  onClose: () => void
  dispatch: (action: Record<string, unknown>) => Promise<DispatchResult>
  onRefresh: () => Promise<void>
}): JSX.Element {
  const [tab, setTab] = useState<TabId>(task.status === 'review' ? 'review' : 'contract')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const act = async (action: Record<string, unknown>): Promise<void> => {
    setBusy(true)
    setError(null)
    const result = await dispatch({ taskId: task.id, ...action })
    setBusy(false)
    if (!result.ok) setError(`${result.code ?? ''}: ${result.error ?? '操作失败'}`)
    await onRefresh()
  }

  return (
    <div className="tf-overlay" onClick={event => { if (event.target === event.currentTarget) onClose() }}>
      <aside className="tf-drawer" role="dialog" aria-label={`任务详情 ${task.title}`}>
        <header className="tf-drawer-head">
          <span className="tf-status-tag" data-status={task.status}>
            <i aria-hidden="true" />
            {statusLabel(task.status)}
          </span>
          <span className="tf-drawer-title" title={task.title}>{task.title}</span>
          {task.round > 1 && <span className="tf-chip">第 {task.round} 轮</span>}
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
        <div className="tf-drawer-body">
          {error !== null && <div className="tf-banner" role="alert">{error}</div>}
          {tab === 'contract' && <ContractTab task={task} />}
          {tab === 'subtasks' && <SubtasksTab task={task} />}
          {tab === 'review' && <ReviewTab task={task} busy={busy} act={act} />}
          {tab === 'history' && <HistoryTab task={task} />}
          {tab === 'decompose' && <DecomposeTab task={task} />}
          <TaskActions task={task} busy={busy} act={act} />
        </div>
      </aside>
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
    <div className="tf-section">
      <span className="tf-section-title">操作</span>
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
        {task.status === 'blocked' && (
          <button type="button" className="tf-btn" disabled={busy} onClick={() => void act({ type: 'raiseMaxRounds', maxRounds: (task.maxRounds ?? 3) + 2 })}>
            提高迭代上限至 {(task.maxRounds ?? 3) + 2}
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
            {!task.permissionConfirmed && task.contract.pins.permission !== 'read-only' && ' · 需确认'}
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
      <span className="tf-section-title">子任务（{task.subtasks.filter(s => s.status === 'done').length}/{task.subtasks.length} done）</span>
      <div className="tf-list">
        {task.subtasks.map(sub => (
          <SubtaskItem key={sub.id} sub={sub} />
        ))}
      </div>
    </div>
  )
}

function SubtaskItem({ sub }: { sub: Subtask }): JSX.Element {
  return (
    <div className="tf-item">
      <div className="tf-item-head">
        <StatusDot status={sub.status} />
        <span className="tf-item-title">{sub.title}</span>
        <span className="tf-chip">{subtaskStatusLabel(sub.status)}</span>
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

// —— 验收页（FR-07 / §4.6）——

function ReviewTab({
  task,
  busy,
  act,
}: {
  task: Task
  busy: boolean
  act: (action: Record<string, unknown>) => Promise<void>
}): JSX.Element {
  const [comment, setComment] = useState('')
  const inReview = task.subtasks.filter(s => s.status === 'review')
  const canReject = inReview.length > 0
  const atLimit = task.maxRounds !== null && task.round + 1 > task.maxRounds

  return (
    <>
      <div className="tf-section">
        <span className="tf-section-title">完成证明（证据报告卡）</span>
        {task.subtasks.filter(s => s.evidence !== undefined).length === 0 && (
          <span className="tf-hint">暂无证据。子任务完成时由执行会话提交。</span>
        )}
        <div className="tf-list">
          {task.subtasks.filter(s => s.evidence !== undefined).map(sub => (
            <EvidenceCard key={sub.id} sub={sub} />
          ))}
        </div>
      </div>
      <div className="tf-section">
        <span className="tf-section-title">验收操作</span>
        {task.status === 'review' ? (
          <>
            <div className="tf-actions">
              <button
                type="button"
                className="tf-btn tf-btn-primary"
                disabled={busy}
                onClick={() => void act({ type: 'approveTask' })}
              >
                批准 · 全部通过（→ done）
              </button>
            </div>
            <div className="tf-field">
              <label htmlFor="tf-comment">打回批语（必填，将原文注入下一轮执行）</label>
              <textarea
                id="tf-comment"
                className="tf-textarea"
                value={comment}
                onChange={event => setComment(event.target.value)}
                placeholder="说清哪里不满足验收标准、期望的修正方向"
              />
            </div>
            <div className="tf-actions">
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
                  打回并继续迭代{canReject ? `（默认选中 ${inReview.length} 个子任务）` : '（无可打回子任务）'}
                </button>
              )}
            </div>
          </>
        ) : task.status === 'in-progress' && inReview.length > 0 ? (
          <>
            <span className="tf-hint">部分子任务已提交证据，可先逐个批准或打回（其余仍在执行）。</span>
            <div className="tf-list">
              {inReview.map(sub => (
                <div className="tf-actions" key={sub.id}>
                  <button type="button" className="tf-btn tf-btn-primary" disabled={busy} onClick={() => void act({ type: 'approveSubtask', subtaskId: sub.id })}>批准「{sub.title}」</button>
                </div>
              ))}
            </div>
            <div className="tf-field">
              <label htmlFor="tf-comment2">打回批语（必填）</label>
              <textarea id="tf-comment2" className="tf-textarea" value={comment} onChange={event => setComment(event.target.value)} />
            </div>
            <div className="tf-actions">
              <button type="button" className="tf-btn tf-btn-danger" disabled={busy || comment.trim().length === 0} onClick={() => void act({ type: 'rejectSubtask', comment })}>打回已举证子任务</button>
            </div>
          </>
        ) : (
          <span className="tf-hint">当前状态 {statusLabel(task.status)}，无待验收操作。</span>
        )}
      </div>
    </>
  )
}

function EvidenceCard({ sub }: { sub: Subtask }): JSX.Element {
  const evidence = sub.evidence
  if (evidence === undefined) return <></>
  const checkById = new Map(evidence.selfCheck.map(check => [check.acceptanceId, check]))
  return (
    <div className="tf-item">
      <div className="tf-item-head">
        <span className="tf-item-title">{sub.title}</span>
        <span className="tf-chip">第 {sub.round} 轮证据</span>
      </div>
      <span className="tf-evidence-label">变更摘要：{evidence.changesSummary}</span>
      {evidence.refs.diffSummary !== undefined && (
        <span className="tf-evidence-diff">{evidence.refs.diffSummary}</span>
      )}
      {evidence.verification.map((record, index) => (
        <div key={index}>
          <div className="tf-item-head">
            <span className={`tf-verdict tf-verdict-${record.passed ? 'pass' : 'fail'}`}>{record.passed ? '通过' : '失败'}</span>
            <span className="tf-ac-id">{record.label}</span>
          </div>
          <pre className="tf-verify">{record.output}</pre>
        </div>
      ))}
      <span className="tf-section-title">逐条自检（对照验收标准）</span>
      <div className="tf-evidence-checks">
        {sub.acceptance.map(item => {
          const check = checkById.get(item.id)
          return (
            <div className="tf-ac" key={item.id}>
              <span className="tf-ac-id">{item.id}</span>
              <span className={`tf-verdict tf-verdict-${check?.verdict ?? 'partial'}`}>{check?.verdict === 'pass' ? 'pass' : check?.verdict === 'partial' ? 'partial' : 'fail'}</span>
              <span>{check?.note ?? '（缺自检条目）'}</span>
            </div>
          )
        })}
      </div>
      <span className="tf-hint">产出会话：{evidence.refs.sessionId}</span>
    </div>
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
