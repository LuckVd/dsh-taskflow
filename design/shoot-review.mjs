/**
 * 验收工作台预览稿截图（一次性工具，与 design/review-preview.html 配套）。
 * 用法：node design/shoot-review.mjs [outdir]
 * 输出：design/previews/review-opt<1|2|3>-<light|dark>.png（默认 outdir = design/previews）
 */
import { chromium } from 'playwright-core'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const outdir = process.argv[2] ?? path.join(root, 'design', 'previews')
const exe = '/root/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome'
const url = `file://${path.join(root, 'design', 'review-preview.html')}`

const combos = [
  { opt: '1', dark: false },
  { opt: '1', dark: true },
  { opt: '2', dark: false },
  { opt: '2', dark: true },
  { opt: '3', dark: false },
  { opt: '3', dark: true },
]

const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] })
try {
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 }, deviceScaleFactor: 1 })
  await page.goto(url, { waitUntil: 'networkidle' })
  for (const { opt, dark } of combos) {
    await page.evaluate(o => {
      const el = document.querySelector('.switcher')
      if (el) el.style.display = 'none'
      document.body.dataset.opt = String(o.opt)
      document.body.classList.toggle('dark', Boolean(o.dark))
      if (typeof window.render === 'function') window.render()
    }, { opt, dark })
    await page.waitForTimeout(250)
    const file = path.join(outdir, `review-opt${opt}-${dark ? 'dark' : 'light'}.png`)
    await page.screenshot({ path: file })
    console.log('wrote', file)
  }
} finally {
  await browser.close()
}