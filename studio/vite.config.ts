import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The core serves the build at /panel/; in dev, /admin is proxied to a running core.
export default defineConfig({
  base: '/panel/',
  plugins: [react()],
  server: {
    proxy: { '/admin': { target: process.env.PANEL_DEV_API || 'http://localhost:8080', changeOrigin: true } },
  },
})
