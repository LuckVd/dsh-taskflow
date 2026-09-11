/**
 * 受限 Markdown 渲染（§4.5b 交付物预览）：React 元素表达，文本走 React 转义，
 * 绝不使用 dangerouslySetInnerHTML——预览的是 AI 产出文件，注入面必须为零。
 * 链接仅放行 http/https/#，其余（javascript: 等）退化为纯文本。
 *
 * @module dsh-taskflow/client
 */

import type { ReactNode } from 'react'
import { parseInline } from './markdown.ts'
import type { MdBlock, MdInlineToken } from './markdown.ts'

function renderInlineToken(token: MdInlineToken, keyPrefix: string): ReactNode {
  switch (token.kind) {
    case 'code':
      return <code className="tf-md-code" key={keyPrefix}>{token.text}</code>
    case 'bold':
      return <strong key={keyPrefix}>{token.text}</strong>
    case 'italic':
      return <em key={keyPrefix}>{token.text}</em>
    case 'link': {
      const safe = /^(https?:\/\/|#)/i.test(token.url)
      if (!safe) return <span key={keyPrefix}>{token.text}</span>
      return (
        <a className="tf-md-link" key={keyPrefix} href={token.url} target="_blank" rel="noreferrer noopener">
          {token.text}
        </a>
      )
    }
    default:
      return <span key={keyPrefix}>{token.text}</span>
  }
}

export function renderInline(tokens: MdInlineToken[], keyPrefix = 'i'): ReactNode {
  return tokens.map((token, index) => renderInlineToken(token, `${keyPrefix}-${index}`))
}

/** 块数组 → React 节点（标题/段落/列表/表格/代码/引用/分隔线）。 */
export function renderBlocks(blocks: MdBlock[], keyPrefix = 'b'): ReactNode[] {
  return blocks.map((block, index) => {
    const key = `${keyPrefix}-${index}`
    switch (block.kind) {
      case 'heading': {
        const level = Math.min(Math.max(block.level, 1), 6)
        const Tag = `h${level}` as 'h1'
        return <Tag className={`tf-md-h tf-md-h${level}`} key={key}>{renderInline(block.tokens, key)}</Tag>
      }
      case 'paragraph':
        return <p className="tf-md-p" key={key}>{renderInline(block.tokens, key)}</p>
      case 'code':
        return <pre className="tf-md-pre" key={key}><code>{block.text}</code></pre>
      case 'list':
        return block.ordered ? (
          <ol className="tf-md-list" key={key}>
            {block.items.map((item, i) => <li key={`${key}-${i}`}>{renderInline(item, `${key}-${i}`)}</li>)}
          </ol>
        ) : (
          <ul className="tf-md-list" key={key}>
            {block.items.map((item, i) => <li key={`${key}-${i}`}>{renderInline(item, `${key}-${i}`)}</li>)}
          </ul>
        )
      case 'table':
        return (
          <div className="tf-md-tablewrap" key={key}>
            <table className="tf-md-table">
              <thead>
                <tr>{block.header.map((cell, i) => <th key={`${key}-h-${i}`}>{renderInline(cell, `${key}-h-${i}`)}</th>)}</tr>
              </thead>
              <tbody>
                {block.rows.map((row, r) => (
                  <tr key={`${key}-r-${r}`}>
                    {row.map((cell, c) => <td key={`${key}-r-${r}-${c}`}>{renderInline(cell, `${key}-r-${r}-${c}`)}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      case 'quote':
        return <blockquote className="tf-md-quote" key={key}>{renderInline(block.tokens, key)}</blockquote>
      case 'hr':
        return <hr className="tf-md-hr" key={key} />
    }
  })
}
