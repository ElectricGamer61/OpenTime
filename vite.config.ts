import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: 'src/renderer',
  // Relative base so the built bundle loads over file:// in the packaged app.
  base: './',
  plugins: [react()],
  build: {
    outDir: '../../dist/renderer',
    emptyOutDir: true,
    target: 'chrome128',
    // No vendor chunking: this is a local file:// app, there is no network
    // waterfall to optimise, and one file parses fastest.
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
  server: { port: 5273, strictPort: true },
})
