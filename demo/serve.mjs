/**
 * demo 服务器：真实 TaskflowEngine（mock 会话适配器）驱动完整 UI。
 *
 * - GET  /                     demo 页
 * - GET  /client.js            客户端 bundle（npm run build 产物）
 * - /api/taskflow/*            宿主同款端点（state / action / events SSE / settings / models）
 *
 * 运行：npm run build && npm run demo → http://127.0.0.1:4173
 */

import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')

// 加载构建产物（同时验证 dist 可用）；核心层不依赖任何 @deepseek-ai 包
const dist = name => path.join(root, 'dist', name)
const { TaskflowEngine, DEFAULT_ENGINE_CONFIG } = await import(dist('host/engine.js'))
const { LedgerStore } = await import(dist('host/ledger.js'))
const { MockSessionAdapter } = await import(dist('host/mock/session-adapter.js'))
const { handleTaskflowRequest, createSseStream, isTrustedRequest } = await import(dist('host/http.js'))
const { validateModelSettings } = await import(dist('host/settings.js'))

const dataFile = path.join(root, 'demo-data', 'ledger.json')

// —— demo 场景脚本：第 1 个子任务首轮自检有瑕疵（可体验打回），其余全过 ——
const adapter = new MockSessionAdapter({
  getLedger: () => engine.getState().ledger,
})
adapter.executionBehavior = async (input, call) => {
  const ledger = engine.getState().ledger
  const sub = ledger.tasks.flatMap(t => t.subtasks).find(s => s.id === input.subtaskId)
  if (sub === undefined) throw new Error('demo: subtask missing')
  // 审批模式演示（§7.1b）：approval 任务的子任务先发起提权审批，等看板/通知栏裁决
  if (input.executionMode === 'approval') {
    const decision = await input.approvals.request({
      sessionId: input.sessionId,
      toolName: 'write',
      reason: '（demo）需要向工作区写入 markdown 文件，请求提升到 workspace-write',
    })
    if (decision === 'rejected') {
      await input.tools.reportBlocker('（demo）提权被拒：无法写文件，子任务中止；可调整方案后重试')
      return
    }
  }
  const good = {
    changesSummary: `（demo）完成「${sub.title}」：按验收标准实现并本地验证。`,
    verification: [
      { label: 'pnpm test', output: '\n ✓ demo/step.spec.ts (3 tests) 8ms\n\n Test Files  1 passed (1)\n      Tests  3 passed (3)', passed: true },
    ],
    selfCheck: sub.acceptance.map(a => ({ acceptanceId: a.id, verdict: 'pass', note: '逐条对照通过' })),
    diffSummary: '+42 −7（src/step.ts, test/step.spec.ts）',
  }
  // 首个子任务第一轮：故意留一条 partial，展示打回/迭代流
  if (sub.id.endsWith('_s1') && sub.round === 1) {
    good.selfCheck = sub.acceptance.map((a, i) => ({
      acceptanceId: a.id,
      verdict: i === sub.acceptance.length - 1 ? 'partial' : 'pass',
      note: i === sub.acceptance.length - 1 ? '主流程通过，但边界场景（空输入）未覆盖' : '逐条对照通过',
    }))
  }
  const result = await input.tools.submitEvidence(good)
  if (!result.accepted) throw new Error(`demo evidence rejected: ${result.correction}`)
  await input.tools.updateProgress(`第 ${call.round} 轮执行完成，证据已提交`)
}

const engine = new TaskflowEngine(new LedgerStore(dataFile), adapter, DEFAULT_ENGINE_CONFIG)
await engine.boot()

// 首次启动播种两个演示任务（幂等：requestId 去重）
await engine.dispatch({
  type: 'createTask',
  requestId: 'demo-seed-1',
  title: '给计算器加上百分比按钮',
  description: '计算器 Web 界面缺少百分比运算：补按钮、实现逻辑、加单元测试并更新使用说明。',
})
await engine.dispatch({
  type: 'createTask',
  requestId: 'demo-seed-2',
  title: '整理本周阅读清单',
  description: '把收藏夹里攒的文章整理成一份带摘要的周报 markdown。',
  // 审批模式演示：提权请求会出现在全局通知栏与抽屉审批区（§7.1b）
  pins: { executionMode: 'approval' },
})

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1:4173')
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(await readFile(path.join(here, 'index.html'), 'utf8'))
      return
    }
    if (req.method === 'GET' && (url.pathname === '/client.js' || url.pathname === '/client.demo.js')) {
      const file = path.join(root, 'dist', url.pathname.slice(1))
      if (!existsSync(file)) {
        res.writeHead(500, { 'content-type': 'text/plain' })
        res.end('dist/client.js 不存在：请先 npm run build')
        return
      }
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
      res.end(await readFile(file, 'utf8'))
      return
    }
    if (url.pathname.startsWith('/api/taskflow/')) {
      if (!isTrustedRequest(req.headers)) {
        res.writeHead(403, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'forbidden' }))
        return
      }
      if (url.pathname === '/api/taskflow/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
        const stream = createSseStream(engine, chunk => res.write(chunk))
        req.on('close', () => stream.dispose())
        return
      }
      // 模型设置（§PLAN-MODEL）：demo 内存态 + 静态目录（真实宿主由 ctx.llm 投影）
      if (url.pathname === '/api/taskflow/settings') {
        if (req.method === 'GET') {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify(engine.getModelSettings()))
          return
        }
        if (req.method === 'PUT') {
          const chunks = []
          for await (const chunk of req) chunks.push(chunk)
          try {
            const next = validateModelSettings(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'))
            engine.setModelSettings(next)
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify(engine.getModelSettings()))
          } catch (error) {
            res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }))
          }
          return
        }
      }
      if (url.pathname === '/api/taskflow/models' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({
          default: { provider: 'deepseek', model: 'deepseek-chat' },
          groups: [
            {
              id: 'deepseek',
              name: 'DeepSeek',
              models: [
                { id: 'deepseek-chat', name: 'deepseek-chat' },
                {
                  id: 'deepseek-reasoner',
                  name: 'deepseek-reasoner',
                  reasoning: {
                    efforts: [
                      { id: 'low', name: '低' },
                      { id: 'medium', name: '中' },
                      { id: 'high', name: '高' },
                    ],
                    defaultEffort: 'high',
                  },
                },
              ],
            },
            {
              id: 'ollama',
              name: 'Ollama（本机）',
              models: [{ id: 'qwen3:8b', name: 'qwen3:8b' }],
            },
          ],
        }))
        return
      }
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const body = req.method === 'POST' ? Buffer.concat(chunks).toString('utf8') : undefined
      const result = await handleTaskflowRequest(engine, req.method ?? 'GET', url.pathname, body)
      res.writeHead(result.status, result.headers)
      res.end(result.body)
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found')
  } catch (error) {
    res.writeHead(500, { 'content-type': 'text/plain' })
    res.end(String(error instanceof Error ? error.message : error))
  }
})

server.listen(4173, '127.0.0.1', () => {
  console.log('demo: http://127.0.0.1:4173 （数据目录 demo-data/，删除即可重置）')
})
