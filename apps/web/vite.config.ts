import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: Number(process.env.CHATTY_WEB_PORT ?? 5173),
    proxy: {
      '/api': `http://127.0.0.1:${process.env.CHATTY_API_PORT ?? 8787}`,
      '/stream': {
        target: `ws://127.0.0.1:${process.env.CHATTY_API_PORT ?? 8787}`,
        ws: true,
      },
    },
  },
})
