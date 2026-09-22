import { describe, expect, it } from 'vitest'
import { sessionTokenUsage } from '../../src/host/dsh/adapter.ts'
import { sumTokenUsage } from '../../src/protocol/types.ts'

describe('sumTokenUsage（协议层用量合并）', () => {
  it('两份相加：必选字段恒加，可选字段任一存在才保留', () => {
    const a = { inputTokens: 100, outputTokens: 20, steps: 2 }
    const b = { inputTokens: 30, outputTokens: 5, cacheReadTokens: 10, steps: 1 }
    const merged = sumTokenUsage(a, b)
    expect(merged).toEqual({ inputTokens: 130, outputTokens: 25, cacheReadTokens: 10, steps: 3 })
    expect(merged.cacheWriteTokens).toBeUndefined()
    expect(merged.reasoningTokens).toBeUndefined()
  })

  it('undefined 起点直接采纳', () => {
    const usage = { inputTokens: 7, outputTokens: 3, reasoningTokens: 4, steps: 1 }
    expect(sumTokenUsage(undefined, usage)).toEqual(usage)
  })
})

describe('sessionTokenUsage（适配器回采）', () => {
  it('累加 assistant/message 事件的 usage（rc.1 {type, data} 形态）', () => {
    const session = {
      snapshotEvents: () => [
        { type: 'user/message', data: {} },
        { type: 'assistant/message', data: { usage: { inputTokens: 100, outputTokens: 20 } } },
        { type: 'tool/call', data: {} },
        { type: 'assistant/message', data: { usage: { inputTokens: 50, outputTokens: 10, reasoningTokens: 8 } } },
      ],
    }
    expect(sessionTokenUsage(session)).toEqual({ inputTokens: 150, outputTokens: 30, reasoningTokens: 8, steps: 2 })
  })

  it('兼容扁平事件形态（usage 直接在事件上）', () => {
    const session = {
      events: [{ type: 'assistant/message', usage: { inputTokens: 9, outputTokens: 1 } }],
    }
    expect(sessionTokenUsage(session)).toMatchObject({ inputTokens: 9, outputTokens: 1, steps: 1 })
  })

  it('无 usage 回报的事件跳过；全无回报 = undefined；畸形 usage 不炸', () => {
    expect(sessionTokenUsage({ events: [{ type: 'assistant/message', data: {} }] })).toBeUndefined()
    expect(sessionTokenUsage({ events: [] })).toBeUndefined()
    expect(sessionTokenUsage(undefined)).toBeUndefined()
    expect(sessionTokenUsage({ events: [{ type: 'assistant/message', data: { usage: { inputTokens: 'x' } } }] })).toBeUndefined()
  })
})
