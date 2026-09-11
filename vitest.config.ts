import { defineConfig } from 'vitest/config'

export default defineConfig({
  // 源码 .tsx 的 JSX 转换与构建脚本（scripts/build-client.mjs jsx: 'automatic'）保持同款
  esbuild: { jsx: 'automatic' },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 10_000,
  },
})
