import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

// The dev server normally runs Svelte's development build, which records a
// stack trace on every state update and makes typing several times slower in
// long plans. Balance is used day to day through the dev server for hot
// reload, so keep the production runtime there unless debugging Svelte itself
// with BALANCE_SVELTE_DEBUG=1.
const svelteDebug = process.env.BALANCE_SVELTE_DEBUG === '1'

// https://vite.dev/config/
export default defineConfig({
  plugins: [svelte({ compilerOptions: { dev: svelteDebug } })],
  resolve: svelteDebug ? {} : { conditions: ['module', 'browser', 'production'] },
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['@jsquash/webp'] },
  server: {
    host: '127.0.0.1',
    port: 5123,
    strictPort: true,
    watch: {
      // Playwright writes transient trace HTML and screenshots while tests are
      // running. Watching those files reloads unrelated pages in other workers.
      ignored: ['**/artifacts/**'],
    },
  },
})
