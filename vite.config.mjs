import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

export default defineConfig({
    plugins: [svelte()],
    // Use a relative base in production so file:// URLs resolve assets correctly
    base: './',
    server: {
        // Align with dev scripts in package.json
        port: 5174,
        strictPort: true,
        host: '127.0.0.1'
    },
    build: {
        outDir: 'dist',
        emptyOutDir: true,
        assetsDir: 'assets'
    }
})


