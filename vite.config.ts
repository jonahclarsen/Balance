import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

// https://vite.dev/config/
export default defineConfig({
  plugins: [svelte()],
  server: {
    host: '127.0.0.1',
    port: 5175,
    strictPort: true,
    watch: {
      // Playwright writes transient trace HTML and screenshots while tests are
      // running. Watching those files reloads unrelated pages in other workers.
      ignored: ['**/artifacts/**'],
    },
  },
})
