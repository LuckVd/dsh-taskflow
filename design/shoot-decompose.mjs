import { chromium } from 'playwright-core'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const url = `file://${path.join(root, 'design', 'decompose-preview.html')}`
const exe = '/root/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome'
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] })
try {
  const page = await browser.newPage({ viewport: { width: 1500, height: 900 }, deviceScaleFactor: 1 })
  await page.goto(url, { waitUntil: 'networkidle' })
  await page.waitForTimeout(250)
  await page.screenshot({ path: path.join(root, 'design', 'previews', 'decompose-options.png') })
  console.log('wrote design/previews/decompose-options.png')
} finally { await browser.close() }
