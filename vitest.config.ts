import { defineConfig } from 'vitest/config'

export default defineConfig({
  // 源码 .tsx 的 JSX 转换与构建脚本（scripts/build-client.mjs jsx: 'automatic'）保持同款
  esbuild: { jsx: 'automatic' },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // 引擎测试有多个 7s 级看门狗用例 + fire-and-forget 汇合轮询；
    // 全量跑机器负载高时 10s 会误杀（2026-09-15 两次不同的偶发超时），放宽到 20s。
    testTimeout: 20_000,
  },
})
