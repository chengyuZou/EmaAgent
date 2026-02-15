import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // WebSocket 聊天
      '/api/ws/chat': {
        target: 'ws://localhost:8000',
        ws: true,
        changeOrigin: true,
        timeout: 120000,
      },
      // Live2D WebSocket
      '/api/live2d/ws': {
        target: 'ws://localhost:8000',
        ws: true,
        changeOrigin: true,
      },
      // REST API（放在 WebSocket 后面）
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
      // 音频文件
      '/audio': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
      // Live2D 模型文件
      '/live2d': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
      '/static': {  // ← 新增：代理静态资源到后端
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
    },
  },
  publicDir: 'public',
})
