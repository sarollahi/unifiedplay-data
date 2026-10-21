import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// Adapters import '@unifiedplay/data': the tests use its source, no build needed.
export default defineConfig({
  resolve: { alias: { '@unifiedplay/data': fileURLToPath(new URL('./packages/data/src/index.ts', import.meta.url)) } },
  test: { environment: 'jsdom', include: ['packages/*/test/**/*.test.ts'] },
})
