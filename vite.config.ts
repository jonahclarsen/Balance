import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

// https://vite.dev/config/
export default defineConfig({
  plugins: [svelte()],
  server: {
    watch: {
      // Playwright writes transient trace HTML and screenshots while tests are
      // running. Watching those files reloads unrelated pages in other workers.
      ignored: ['**/artifacts/**'],
    },
  },
})
