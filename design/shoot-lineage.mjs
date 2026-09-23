/** 血缘预览截图（一次性，配套 design/lineage-preview.html）。用法：node design/shoot-lineage.mjs
 *  输出深浅两套：lineage-<scene>.png（深）与 lineage-<scene>-light.png（浅，README 配图用）。 */
import { chromium } from 'playwright-core'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const outdir = path.join(root, 'design', 'previews')
const exe = '/root/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome'
const url = `file://${path.join(root, 'design', 'lineage-preview.html')}`

const scenes = ['board', 'flow', 'graph', 'form']
const themes = ['', 'light']
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] })
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.5 })
  await page.goto(url, { waitUntil: 'networkidle' })
  for (const theme of themes) {
    for (const s of scenes) {
      await page.evaluate(({ scene, light }) => {
        document.querySelector('.switcher').style.display = 'none'
        document.body.dataset.scene = scene
        document.body.classList.toggle('light', light)
        if (scene === 'board') window.render()
      }, { scene: s, light: theme === 'light' })
      await page.waitForTimeout(250)
      const suffix = theme === 'light' ? '-light' : ''
      const file = path.join(outdir, `lineage-${s}${suffix}.png`)
      await page.screenshot({ path: file })
      console.log('wrote', file)
    }
  }
} finally { await browser.close() }
