/**
 * cron 触发建卡（FR-17）：标准 5 字段 cron（分 时 日 月 周）驱动无人值守场景。
 *
 * - 匹配器纯函数（matchesCron），支持 通配、步长（n 分之一）、区间、列表及其组合；
 * - 调度器按分钟去重：同一 (scheduleId, minute) 只发一次——幂等 requestId
 *   （sched_id_epochMinute）双保险，重启后不会重发已发过的分钟（以时钟为准，
 *   回拨时钟在下一分钟恢复触发，不做历史补偿）；
 * - tick 默认 30s；now() 可注入（测试）。回调抛错不杀定时器（记入 onTickError）。
 *
 * 文件变动触发经 2026-09-15 裁决不做：inotify/watcher 面 + 去抖语义复杂，单用户
 * 场景价值最弱（cron + webhook 已覆盖无人值守建卡），确有需要再评估。
 *
 * @module dsh-taskflow/host
 */

export class CronFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CronFormatError'
  }
}

const FIELD_RANGES: Array<{ min: number; max: number; name: string }> = [
  { min: 0, max: 59, name: 'minute' },
  { min: 0, max: 23, name: 'hour' },
  { min: 1, max: 31, name: 'day-of-month' },
  { min: 1, max: 12, name: 'month' },
  { min: 0, max: 6, name: 'day-of-week' },
]

/** 解析单个字段为命中集合；支持通配、步长（n 分之一）、区间、列表及组合。 */
function parseField(raw: string, index: number): Set<number> {
  const range = FIELD_RANGES[index]!
  const values = new Set<number>()
  for (const part of raw.split(',')) {
    if (part.length === 0) throw new CronFormatError(`cron 字段 ${range.name} 含空片段`)
    let step = 1
    let span = part
    const slash = part.indexOf('/')
    if (slash >= 0) {
      span = part.slice(0, slash)
      const stepRaw = part.slice(slash + 1)
      if (!/^\d+$/.test(stepRaw)) throw new CronFormatError(`cron 字段 ${range.name} 步长非法：${part}`)
      step = Number.parseInt(stepRaw, 10)
      if (step < 1) throw new CronFormatError(`cron 字段 ${range.name} 步长须 ≥ 1：${part}`)
    }
    let from: number
    let to: number
    if (span === '*') {
      from = range.min
      to = range.max
    } else if (/^\d+$/.test(span)) {
      from = Number.parseInt(span, 10)
      to = slash >= 0 ? range.max : from
    } else {
      const dash = span.indexOf('-')
      if (dash < 0 || !/^\d+$/.test(span.slice(0, dash)) || !/^\d+$/.test(span.slice(dash + 1))) {
        throw new CronFormatError(`cron 字段 ${range.name} 片段非法：${part}`)
      }
      from = Number.parseInt(span.slice(0, dash), 10)
      to = Number.parseInt(span.slice(dash + 1), 10)
      if (from > to) throw new CronFormatError(`cron 字段 ${range.name} 区间倒置：${part}`)
    }
    if (from < range.min || to > range.max) {
      throw new CronFormatError(`cron 字段 ${range.name} 越界（${range.min}-${range.max}）：${part}`)
    }
    for (let v = from; v <= to; v += step) values.add(v)
  }
  return values
}

export interface ParsedCron {
  minutes: Set<number>
  hours: Set<number>
  days: Set<number>
  months: Set<number>
  dows: Set<number>
  /** 显式约束了日或周（非 *）——标准 cron 语义：两者都受限时命中任一即可。 */
  dayRestricted: boolean
  dowRestricted: boolean
}

/** 校验并解析表达式；非法抛 CronFormatError。 */
export function parseCron(expr: string): ParsedCron {
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== 5) throw new CronFormatError(`cron 须为 5 字段（分 时 日 月 周）：${expr}`)
  const parsed = fields.map((f, i) => parseField(f, i))
  return {
    minutes: parsed[0]!,
    hours: parsed[1]!,
    days: parsed[2]!,
    months: parsed[3]!,
    dows: parsed[4]!,
    dayRestricted: !fields[2]!.trim().startsWith('*'),
    dowRestricted: !fields[4]!.trim().startsWith('*'),
  }
}

/** 该时刻是否命中（标准 cron 语义：日/周均显式受限时任一命中即可）。 */
export function matchesCron(cron: ParsedCron, at: Date): boolean {
  if (!cron.minutes.has(at.getMinutes())) return false
  if (!cron.hours.has(at.getHours())) return false
  if (!cron.months.has(at.getMonth() + 1)) return false
  const dayHit = cron.days.has(at.getDate())
  const dowHit = cron.dows.has(at.getDay())
  if (cron.dayRestricted && cron.dowRestricted) return dayHit || dowHit
  if (cron.dayRestricted) return dayHit
  if (cron.dowRestricted) return dowHit
  return true
}

/** 一条 cron 触发规格（plugin config.schedules[] 项）。 */
export interface CronScheduleSpec {
  /** 规格标识（requestId 幂等前缀用；缺省用下标）。 */
  id?: string
  cron: string
  title: string
  description?: string
  acceptance?: string[]
  objective?: string
  pins?: Record<string, unknown>
  autoStart?: boolean
  maxRounds?: number | null
}

export function validateScheduleSpec(raw: CronScheduleSpec, fallbackId: string): CronScheduleSpec {
  if (typeof raw.cron !== 'string' || raw.cron.trim().length === 0) throw new CronFormatError('schedule 缺少 cron 表达式')
  parseCron(raw.cron) // 校验
  if (typeof raw.title !== 'string' || raw.title.trim().length === 0) throw new CronFormatError('schedule 缺少 title')
  return { ...raw, id: raw.id ?? fallbackId }
}

/**
 * 分钟级调度器：每 tick 检查当前分钟是否命中且未发过。返回停止函数。
 * `fire` 收到 (spec, requestId)——调用方负责 dispatch（幂等由 requestId 保证）。
 */
export class CronScheduler {
  private readonly timer: ReturnType<typeof setInterval> | undefined
  private readonly firedMinutes = new Map<string, number>()
  private disposed = false

  constructor(
    private readonly schedules: readonly CronScheduleSpec[],
    fire: (spec: CronScheduleSpec, requestId: string) => Promise<unknown> | unknown,
    opts: { tickMs?: number; now?: () => Date; onTickError?: (error: unknown) => void } = {},
  ) {
    if (schedules.length === 0) return
    const tick = opts.tickMs ?? 30_000
    const now = opts.now ?? (() => new Date())
    const check = (): void => {
      if (this.disposed) return
      const at = now()
      const epochMinute = Math.floor(at.getTime() / 60_000)
      for (const [index, spec] of schedules.entries()) {
        let parsed: ParsedCron
        try {
          parsed = parseCron(spec.cron)
        } catch {
          continue // 配置错不杀定时器：跳过该条（启动时 validate 已报过错）
        }
        if (!matchesCron(parsed, at)) continue
        const key = spec.id ?? `s${index}`
        if (this.firedMinutes.get(key) === epochMinute) continue
        this.firedMinutes.set(key, epochMinute)
        try {
          void Promise.resolve(fire(spec, `sched_${key}_${epochMinute}`)).catch(error => opts.onTickError?.(error))
        } catch (error) {
          opts.onTickError?.(error)
        }
      }
    }
    this.timer = setInterval(check, tick)
    check()
  }

  dispose(): void {
    this.disposed = true
    if (this.timer !== undefined) clearInterval(this.timer)
  }
}
