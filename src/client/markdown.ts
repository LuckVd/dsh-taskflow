/**
 * 受限 Markdown 块解析器（§4.5b 交付物预览用）——纯数据、零依赖、可单测。
 *
 * 安全立场：只产出结构化块，从不产出 HTML 字符串；渲染层（MarkdownView）用
 * React 元素表达，文本一律走 React 转义，天然免疫注入。支持的语法子集以
 * 「AI 落盘报告」的实际形态为准：标题、段落、无序/有序列表、管道表格、
 * 围栏代码块、引用、分隔线；行内支持 `code`、**粗体**、*斜体*、[文本](URL)。
 *
 * @module dsh-taskflow/client
 */

export type MdInlineToken =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'bold'; text: string }
  | { kind: 'italic'; text: string }
  | { kind: 'link'; text: string; url: string }

export type MdBlock =
  | { kind: 'heading'; level: number; tokens: MdInlineToken[] }
  | { kind: 'paragraph'; tokens: MdInlineToken[] }
  | { kind: 'code'; lang: string; text: string }
  | { kind: 'list'; ordered: boolean; items: MdInlineToken[][] }
  | { kind: 'table'; header: MdInlineToken[][]; rows: MdInlineToken[][][] }
  | { kind: 'quote'; tokens: MdInlineToken[] }
  | { kind: 'hr' }

const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/
const HEADING_RE = /^(#{1,6})\s+(.*)$/
const HR_RE = /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/
const QUOTE_RE = /^\s{0,3}>\s?(.*)$/
const TABLE_ROW_RE = /^\s*\|.*\|\s*$/
const TABLE_SEP_RE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/

/** 行内分词：`code` / **bold** / *italic* / [text](url)；其余为纯文本。 */
export function parseInline(text: string): MdInlineToken[] {
  const tokens: MdInlineToken[] = []
  const re = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*|\[[^\]\n]+\]\([^)\s]+\))/g
  let last = 0
  for (const match of text.matchAll(re)) {
    const start = match.index ?? 0
    if (start > last) tokens.push({ kind: 'text', text: text.slice(last, start) })
    const raw = match[0]
    if (raw.startsWith('`')) tokens.push({ kind: 'code', text: raw.slice(1, -1) })
    else if (raw.startsWith('**')) tokens.push({ kind: 'bold', text: raw.slice(2, -2) })
    else if (raw.startsWith('*')) tokens.push({ kind: 'italic', text: raw.slice(1, -1) })
    else {
      const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(raw)
      if (link !== null) tokens.push({ kind: 'link', text: link[1] ?? '', url: link[2] ?? '' })
      else tokens.push({ kind: 'text', text: raw })
    }
    last = start + raw.length
  }
  if (last < text.length) tokens.push({ kind: 'text', text: text.slice(last) })
  return tokens.length > 0 ? tokens : [{ kind: 'text', text: '' }]
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  return trimmed.split('|').map(cell => cell.trim())
}

/**
 * 块级解析：行扫描，段落缓冲到空行/块起始为止。
 * 刻意不支持：原生 HTML 行（按普通文本渲染）、嵌套列表（拍平）、脚注/任务列表。
 */
export function parseMarkdown(source: string): MdBlock[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const blocks: MdBlock[] = []
  let paragraph: string[] = []

  const flushParagraph = () => {
    if (paragraph.length === 0) return
    blocks.push({ kind: 'paragraph', tokens: parseInline(paragraph.join(' ').trim()) })
    paragraph = []
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''

    // 围栏代码块（``` 或 ~~~；信息串可空）
    const fence = /^(\s{0,3})(```|~~~)\s*(.*)$/.exec(line)
    if (fence !== null) {
      flushParagraph()
      const marker = fence[2] ?? '```'
      const lang = (fence[3] ?? '').trim()
      const body: string[] = []
      i += 1
      for (; i < lines.length; i++) {
        const inner = lines[i] ?? ''
        if (inner.trimStart().startsWith(marker)) break
        body.push(inner)
      }
      blocks.push({ kind: 'code', lang, text: body.join('\n') })
      continue
    }

    if (HR_RE.test(line)) {
      flushParagraph()
      blocks.push({ kind: 'hr' })
      continue
    }

    const heading = HEADING_RE.exec(line)
    if (heading !== null) {
      flushParagraph()
      blocks.push({ kind: 'heading', level: (heading[1] ?? '#').length, tokens: parseInline((heading[2] ?? '').trim()) })
      continue
    }

    // 管道表格：当前行含管道且下一行是分隔行
    if (TABLE_ROW_RE.test(line) && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1] ?? '')) {
      flushParagraph()
      const header = splitTableRow(line)
      const rows: MdInlineToken[][][] = []
      i += 2
      for (; i < lines.length; i++) {
        const rowLine = lines[i] ?? ''
        if (!TABLE_ROW_RE.test(rowLine)) {
          i -= 1
          break
        }
        rows.push(splitTableRow(rowLine).map(cell => parseInline(cell)))
      }
      blocks.push({ kind: 'table', header: header.map(cell => parseInline(cell)), rows })
      continue
    }

    // 引用：连续 > 行合并为一段
    const quote = QUOTE_RE.exec(line)
    if (quote !== null) {
      flushParagraph()
      const body: string[] = [quote[1] ?? '']
      for (i += 1; i < lines.length; i++) {
        const inner = QUOTE_RE.exec(lines[i] ?? '')
        if (inner === null) {
          i -= 1
          break
        }
        body.push(inner[1] ?? '')
      }
      blocks.push({ kind: 'quote', tokens: parseInline(body.join(' ').trim()) })
      continue
    }

    // 列表：连续列表行归一组（嵌套拍平）
    const list = LIST_RE.exec(line)
    if (list !== null) {
      flushParagraph()
      const ordered = /\d/.test(list[2] ?? '')
      const items: MdInlineToken[][] = [parseInline((list[3] ?? '').trim())]
      for (i += 1; i < lines.length; i++) {
        const inner = LIST_RE.exec(lines[i] ?? '')
        if (inner === null) {
          i -= 1
          break
        }
        items.push(parseInline((inner[3] ?? '').trim()))
      }
      blocks.push({ kind: 'list', ordered, items })
      continue
    }

    if (line.trim().length === 0) {
      flushParagraph()
      continue
    }
    paragraph.push(line.trim())
  }
  flushParagraph()
  return blocks
}
