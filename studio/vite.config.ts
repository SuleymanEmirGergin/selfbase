import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// control serves the build at / (STUDIO_DIR); in dev, /platform is proxied to a running control.
export default defineConfig({
  base: '/',
  plugins: [react()],
  server: {
    proxy: { '/platform': { target: process.env.STUDIO_DEV_API || 'http://localhost:8080', changeOrigin: true } },
  },
})
