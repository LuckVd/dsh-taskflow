/**
 * 客户端构建（esbuild）：
 * - dist/client.js      —— ESM bundle（直接挂载用；react 等为 external）
 * - dist/client.iife.js —— IIFE 测试产物（react 内联，全局名 __taskflowTest；
 *                         客户端渲染冒烟 test/client/render.test.ts 在 jsdom 里 eval 它）
 * - dist/client.dsh.js  —— dsh 客户端模块形态（window.__ModuleLoader__.load 工厂约定）
 */

import { build } from 'esbuild'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const external = ['react', 'react-dom', 'react-dom/client', '@deepseek-ai/*']
const root = new URL('..', import.meta.url).pathname
const outdir = path.join(root, 'dist')
mkdirSync(outdir, { recursive: true })

// 1) ESM bundle
await build({
  entryPoints: [path.join(root, 'src/client/index.ts')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  jsx: 'automatic',
  outfile: path.join(outdir, 'client.js'),
  external: [...external],
  logLevel: 'info',
})

// 1.5) IIFE 测试产物（渲染冒烟用；react 内联，浏览器 <script> 亦可直接跑）
await build({
  entryPoints: [path.join(root, 'src/client/index.ts')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  jsx: 'automatic',
  outfile: path.join(outdir, 'client.iife.js'),
  globalName: '__taskflowTest',
  logLevel: 'info',
})

// 2) dsh 客户端模块形态：CJS 体 + __ModuleLoader__ 工厂包装
await build({
  entryPoints: [path.join(root, 'src/client/index.ts')],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  jsx: 'automatic',
  outfile: path.join(outdir, 'client.cjs.js'),
  external: [...external],
  logLevel: 'info',
})
const cjs = await import('node:fs/promises').then(fs => fs.readFile(path.join(outdir, 'client.cjs.js'), 'utf8'))
const wrapped = `;(function () {
  if (typeof window === 'undefined' || !window.__ModuleLoader__) return
  window.__ModuleLoader__.load({
    id: 'dsh-taskflow',
    factory: function (require) {
      var module = { exports: {} }
      ;(function (module, exports, require) {
${cjs}
      })(module, module.exports, require)
      return module.exports
    },
  })
})()
`
writeFileSync(path.join(outdir, 'client.dsh.js'), wrapped)
console.log('client bundles written to dist/')
