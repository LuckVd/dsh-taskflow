/** 血缘预览截图（一次性，配套 design/lineage-preview.html）。用法：node design/shoot-lineage.mjs */
import { chromium } from 'playwright-core'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const outdir = path.join(root, 'design', 'previews')
const exe = '/root/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome'
const url = `file://${path.join(root, 'design', 'lineage-preview.html')}`

const scenes = ['board', 'flow', 'graph', 'form']
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] })
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.5 })
  await page.goto(url, { waitUntil: 'networkidle' })
  for (const s of scenes) {
    await page.evaluate(v => {
      document.querySelector('.switcher').style.display = 'none'
      document.body.dataset.scene = v
      if (v === 'board') window.render()
    }, s)
    await page.waitForTimeout(250)
    const file = path.join(outdir, `lineage-${s}.png`)
    await page.screenshot({ path: file })
    console.log('wrote', file)
  }
} finally { await browser.close() }
