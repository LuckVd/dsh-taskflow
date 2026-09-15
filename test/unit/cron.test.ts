/**
 * cron 触发建卡（FR-17）：匹配器语义、调度器分钟去重与幂等 requestId。
 */
import { describe, expect, it } from 'vitest'
import { CronFormatError, CronScheduler, matchesCron, parseCron, validateScheduleSpec } from '../../src/host/cron.ts'
import type { CronScheduleSpec } from '../../src/host/cron.ts'

function cron(expr: string): ReturnType<typeof parseCron> {
  return parseCron(expr)
}

describe('parseCron / matchesCron（5 字段语义）', () => {
  it('字段数与取值域 fail-closed', () => {
    expect(() => cron('* * * *')).toThrow(CronFormatError)
    expect(() => cron('* * * * * *')).toThrow(CronFormatError)
    expect(() => cron('60 * * * *')).toThrow(/minute/)
    expect(() => cron('* 24 * * *')).toThrow(/hour/)
    expect(() => cron('* * 0 * *')).toThrow(/day-of-month/)
    expect(() => cron('* * * 13 *')).toThrow(/month/)
    expect(() => cron('* * * * 7')).toThrow(/day-of-week/)
    expect(() => cron('a * * * *')).toThrow(CronFormatError)
    expect(() => cron('5-1 * * * *')).toThrow(/倒置/)
  })

  it('整点 / 步长 / 区间 / 列表 / 组合', () => {
    // 每天 08:30
    const daily = cron('30 8 * * *')
    expect(matchesCron(daily, new Date('2026-09-15T08:30:00'))).toBe(true)
    expect(matchesCron(daily, new Date('2026-09-15T08:31:00'))).toBe(false)
    expect(matchesCron(daily, new Date('2026-09-15T09:30:00'))).toBe(false)
    // 每 15 分钟
    const quarter = cron('*/15 * * * *')
    expect(matchesCron(quarter, new Date('2026-09-15T10:00:00'))).toBe(true)
    expect(matchesCron(quarter, new Date('2026-09-15T10:15:00'))).toBe(true)
    expect(matchesCron(quarter, new Date('2026-09-15T10:20:00'))).toBe(false)
    // 工作日 9-18 点（区间×列表组合）
    const workHours = cron('* 9-18 * * 1-5')
    expect(matchesCron(workHours, new Date('2026-09-15T12:00:00'))).toBe(true) // 周二
    expect(matchesCron(workHours, new Date('2026-09-15T20:00:00'))).toBe(false)
    expect(matchesCron(workHours, new Date('2026-09-13T12:00:00'))).toBe(false) // 周日
    // 指定几个分钟
    const list = cron('5,35 * * * *')
    expect(matchesCron(list, new Date('2026-09-15T10:05:00'))).toBe(true)
    expect(matchesCron(list, new Date('2026-09-15T10:06:00'))).toBe(false)
  })

  it('日/周均受限时任一命中即可（标准 cron 语义）', () => {
    const either = cron('0 0 13 * 5') // 13 号 或 周五 零点
    expect(matchesCron(either, new Date('2026-09-13T00:00:00'))).toBe(true) // 13 号（周日）
    expect(matchesCron(either, new Date('2026-09-11T00:00:00'))).toBe(true) // 周五（11 号）
    expect(matchesCron(either, new Date('2026-09-14T00:00:00'))).toBe(false) // 周一 14 号
  })
})

describe('validateScheduleSpec', () => {
  it('缺 cron / 缺 title / 坏表达式拒绝；id 缺省回填', () => {
    expect(() => validateScheduleSpec({ cron: '', title: 't' }, 's0')).toThrow(/cron/)
    expect(() => validateScheduleSpec({ cron: '* * * * *', title: '' }, 's0')).toThrow(/title/)
    expect(() => validateScheduleSpec({ cron: 'x', title: 't' }, 's0')).toThrow(CronFormatError)
    expect(validateScheduleSpec({ cron: '0 9 * * *', title: 't' }, 's7').id).toBe('s7')
  })
})

describe('CronScheduler（分钟去重 + 幂等 requestId + 配置错跳过）', () => {
  function fakeClock(start: Date): { now: () => Date; advanceMinutes: (n: number) => void } {
    let current = start.getTime()
    return {
      now: () => new Date(current),
      advanceMinutes: (n: number) => {
        current += n * 60_000
      },
    }
  }

  it('命中分钟触发一次，同分钟多 tick 去重；下一命中分钟再触发', async () => {
    const fired: Array<{ spec: CronScheduleSpec; requestId: string }> = []
    const clock = fakeClock(new Date('2026-09-15T08:00:30'))
    const scheduler = new CronScheduler([{ id: 'daily', cron: '30 8 * * *', title: '日报' }], (spec, requestId) => {
      fired.push({ spec, requestId })
    }, { tickMs: 10, now: clock.now })

    // 8:00 不命中（30 分才命中）
    await new Promise(r => setTimeout(r, 40))
    expect(fired).toHaveLength(0)

    clock.advanceMinutes(30) // 8:30 —— 命中
    await new Promise(r => setTimeout(r, 40))
    expect(fired).toHaveLength(1)
    expect(fired[0]!.requestId).toMatch(/^sched_daily_\d+$/)

    // 同一 8:30 分钟内多次 tick 不重发
    await new Promise(r => setTimeout(r, 40))
    expect(fired).toHaveLength(1)

    // 推到次日 8:30 再触发（requestId 的分钟数不同）
    clock.advanceMinutes(24 * 60)
    await new Promise(r => setTimeout(r, 40))
    expect(fired).toHaveLength(2)
    expect(fired[1]!.requestId).not.toBe(fired[0]!.requestId)

    scheduler.dispose()
  })

  it('坏表达式条目跳过，不拖垮其他条目；空列表不启定时器', async () => {
    const fired: string[] = []
    const clock = fakeClock(new Date('2026-09-15T09:00:10'))
    const scheduler = new CronScheduler(
      [
        { id: 'bad', cron: 'nope', title: 'x' },
        { id: 'good', cron: '* * * * *', title: 'y' },
      ],
      spec => {
        fired.push(spec.id ?? '?')
      },
      { tickMs: 10, now: clock.now },
    )
    await new Promise(r => setTimeout(r, 40))
    expect(fired).toEqual(['good'])
    scheduler.dispose()

    const empty = new CronScheduler([], () => undefined, { tickMs: 10 })
    empty.dispose() // 不抛错即可
  })
})
