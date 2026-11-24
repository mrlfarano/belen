import { defineConfig } from 'vite'
import solid from 'vite-plugin-solid'

export default defineConfig({
  plugins: [solid()],
  server: {
    port: 1420,
    strictPort: true,
    host: '127.0.0.1',
  },
  clearScreen: false,
  build: {
    target: 'esnext',
    sourcemap: false,
  },
})
