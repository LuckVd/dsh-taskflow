/**
 * 受限 Markdown 解析器单测（§4.5b 交付物预览的渲染管线，纯数据层）。
 */
import { describe, expect, it } from 'vitest'
import { parseInline, parseMarkdown } from '../../src/client/markdown.ts'

describe('行内分词（parseInline）', () => {
  it('code/bold/italic/link 各自识别', () => {
    const tokens = parseInline('前 `code` **粗** *斜* [文](https://a.b) 后')
    expect(tokens.map(t => t.kind)).toEqual(['text', 'code', 'text', 'bold', 'text', 'italic', 'text', 'link', 'text'])
  })

  it('纯文本原样返回；空串产出单个空 text', () => {
    expect(parseInline('plain')).toEqual([{ kind: 'text', text: 'plain' }])
    expect(parseInline('')).toEqual([{ kind: 'text', text: '' }])
  })

  it('link 只在合法 URL 形态下成 token；渲染层另行过滤 javascript:', () => {
    const tokens = parseInline('[x](javascript:alert(1))')
    // URL 含括号内非空白即被捕获；安全性由渲染层协议白名单兜底
    expect(tokens.some(t => t.kind === 'link')).toBe(true)
  })
})

describe('块级解析（parseMarkdown）', () => {
  it('标题层级 / 段落 / 分隔线', () => {
    const blocks = parseMarkdown('# 一\n\n正文段落\n多行合并\n\n---')
    expect(blocks.map(b => b.kind)).toEqual(['heading', 'paragraph', 'hr'])
    const heading = blocks[0]!
    expect(heading).toMatchObject({ kind: 'heading', level: 1 })
  })

  it('围栏代码块保留原文（含 # 与管道），语言信息串可空', () => {
    const blocks = parseMarkdown('```bash\ndu -sh / | grep "|\n# 注释"\n```\n')
    expect(blocks[0]).toMatchObject({ kind: 'code', lang: 'bash' })
    expect((blocks[0] as { text: string }).text).toContain('| grep')
  })

  it('管道表格：表头 + 分隔行 + 多行数据', () => {
    const md = [
      '| 文章 | 优先级 |',
      '|---|---|',
      '| 《A》 | 高 |',
      '| 《B》 | 低 |',
    ].join('\n')
    const blocks = parseMarkdown(md)
    expect(blocks).toHaveLength(1)
    const table = blocks[0] as { kind: string; header: unknown[]; rows: unknown[][] }
    expect(table.kind).toBe('table')
    expect(table.header).toHaveLength(2)
    expect(table.rows).toHaveLength(2)
  })

  it('无序/有序列表；引用合并；HTML 行按普通文本处理（无 HTML 块）', () => {
    const blocks = parseMarkdown('- A\n- B\n\n1. 一\n2. 二\n\n> 引用一\n> 引用二\n\n<div>alert</div>')
    expect(blocks.map(b => b.kind)).toEqual(['list', 'list', 'quote', 'paragraph'])
    const html = blocks[3] as { tokens: Array<{ kind: string; text: string }> }
    expect(html.tokens.map(t => t.text).join('')).toContain('<div>')
  })

  it('CRLF 归一化；截断边界不产生空块', () => {
    const blocks = parseMarkdown('# T\r\n\r\nbody\r\n')
    expect(blocks.map(b => b.kind)).toEqual(['heading', 'paragraph'])
  })
})
