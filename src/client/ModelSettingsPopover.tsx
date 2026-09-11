/**
 * 模型设置浮层（工具栏齿轮，§PLAN-MODEL）：拆解/执行两槽模型选择。
 *
 * - 两槽均为「跟随宿主默认」或显式 provider/model（原生 select + optgroup，同 .tf-select 语言）；
 * - 即改即存（PUT /api/taskflow/settings），失败回滚 UI 并就地报错；
 * - 已保存的模型从目录消失 → 琥珀「不可路由」提示，不擅自清除用户选择；
 * - Esc / 点击面板与齿轮以外区域关闭。
 *
 * @module dsh-taskflow/client
 */

import { useEffect, useRef, useState } from 'react'
import type { ModelCatalog, ModelSettings, SessionModelSelection } from '../protocol/types.ts'
import type { TaskflowTransport } from './api.ts'

type Slot = 'decompose' | 'execution'

const SLOT_META: Record<Slot, { icon: string; title: string; desc: string }> = {
  decompose: { icon: '🧩', title: '拆解 agent', desc: '任务规划 · 验收补全' },
  execution: { icon: '⚡', title: '执行 agent', desc: '子任务实现 · 举证' },
}

function encodeSelection(selection: SessionModelSelection): string {
  return `${selection.provider}::${selection.model}`
}

/** 目录内查找一个已保存的选择（用于推理力度联动与「不可路由」判定）。 */
function findInCatalog(
  catalog: ModelCatalog | null,
  selection: SessionModelSelection | null,
): ModelCatalog['groups'][number]['models'][number] | undefined {
  if (catalog === null || selection === null) return undefined
  return catalog.groups
    .find(group => group.id === selection.provider)
    ?.models.find(model => model.id === selection.model)
}

export function ModelSettingsPopover({
  transport,
  onClose,
}: {
  transport: TaskflowTransport
  onClose: () => void
}): JSX.Element {
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null)
  const [settings, setSettings] = useState<ModelSettings | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [savedTick, setSavedTick] = useState(false)
  const panelRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [models, current] = await Promise.all([transport.getModels(), transport.getSettings()])
        if (cancelled) return
        setCatalog(models)
        setSettings(current)
      } catch (error) {
        if (cancelled) return
        // 目录与设置分开降级：目录挂掉不该让「跟随宿主默认」这一选择也不可用
        setLoadError(error instanceof Error ? error.message : String(error))
        try {
          const current = await transport.getSettings()
          if (!cancelled) setSettings(current)
        } catch {
          // 设置也读不到：保持 loadError 面板
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [transport])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    const onMouseDown = (event: MouseEvent): void => {
      const target = event.target instanceof Node ? event.target : null
      if (target === null) return
      // 齿轮在面板外但在 .tf-settings-anchor 内：交给按钮自己的 toggle，避免「关了又开」
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

  const change = async (slot: Slot, modelValue: string, effort?: string): Promise<void> => {
    if (settings === null) return
    const previous = settings
    let next: ModelSettings
    if (modelValue === '') {
      next = { ...settings, [slot]: null }
    } else {
      const separator = modelValue.indexOf('::')
      const provider = modelValue.slice(0, separator)
      const model = modelValue.slice(separator + 2)
      const resolvedEffort = effort ?? previous[slot]?.reasoningEffort
      next = {
        ...settings,
        [slot]: {
          provider,
          model,
          ...(resolvedEffort !== undefined && resolvedEffort !== '' ? { reasoningEffort: resolvedEffort } : {}),
        },
      }
    }
    setSettings(next)
    setSaveError(null)
    setSavedTick(false)
    try {
      const saved = await transport.saveSettings(next)
      setSettings(saved)
      setSavedTick(true)
      window.setTimeout(() => setSavedTick(false), 2000)
    } catch (error) {
      setSettings(previous)
      setSaveError(error instanceof Error ? error.message : String(error))
    }
  }

  const defaultLabel =
    catalog?.default === null || catalog?.default === undefined
      ? null
      : `${catalog.default.provider}/${catalog.default.model}`

  return (
    <div className="tf-popover" ref={panelRef} role="dialog" aria-label="模型设置">
      <div className="tf-pop-head">
        <span className="tf-pop-title">模型设置</span>
        <button type="button" className="tf-icon-btn" onClick={onClose} aria-label="关闭模型设置">✕</button>
      </div>
      {settings === null ? (
        <span className="tf-hint tf-pop-error">{loadError === null ? '设置加载中…' : `设置加载失败：${loadError}`}</span>
      ) : (
        <>
          {loadError !== null && <span className="tf-hint tf-pop-error">模型目录加载失败：{loadError}</span>}
          {(['decompose', 'execution'] as const).map(slot => {
          const meta = SLOT_META[slot]
          const selection = settings === null ? null : settings[slot]
          const found = findInCatalog(catalog, selection)
          const unroutable = selection !== null && catalog !== null && found === undefined
          const efforts = found?.reasoning?.efforts
          return (
            <div className="tf-slot" key={slot}>
              <span className="tf-slot-label">
                {meta.icon} {meta.title}
                <span className="tf-slot-desc">{meta.desc}</span>
              </span>
              <select
                className={`tf-select${unroutable ? ' tf-select-warn' : ''}`}
                value={selection === null ? '' : encodeSelection(selection)}
                disabled={settings === null}
                aria-label={`${meta.title} · 模型`}
                onChange={event => void change(slot, event.target.value)}
              >
                <option value="">跟随宿主默认{defaultLabel !== null ? `（${defaultLabel}）` : ''}</option>
                {catalog?.groups.map(group => (
                  <optgroup key={group.id} label={group.name}>
                    {group.models.map(model => (
                      <option key={`${group.id}::${model.id}`} value={`${group.id}::${model.id}`}>{model.name}</option>
                    ))}
                  </optgroup>
                ))}
              </select>
              {unroutable && <span className="tf-chip tf-chip-warn">⚠ 当前不可路由</span>}
              {efforts !== undefined && selection !== null && (
                <select
                  className="tf-select"
                  value={selection.reasoningEffort ?? ''}
                  aria-label={`${meta.title} · 推理力度`}
                  onChange={event => void change(slot, encodeSelection(selection), event.target.value)}
                >
                  <option value="">推理力度：默认</option>
                  {efforts.map(effort => (
                    <option key={effort.id} value={effort.id}>{effort.name}</option>
                  ))}
                </select>
              )}
            </div>
          )
          })}
        </>
      )}
      {saveError !== null && <span className="tf-hint tf-pop-error">保存失败：{saveError}</span>}
      <span className="tf-hint">修改只影响之后新建的会话，运行中的会话不受影响。</span>
      <span className="tf-pop-state" role="status" aria-label="保存状态">{savedTick ? '已保存 ✓' : ''}</span>
    </div>
  )
}
