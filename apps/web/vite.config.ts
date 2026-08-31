import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 开发环境把 API 请求代理到后端 :3000，规避跨域
// 代理目标用 127.0.0.1 而非 localhost：macOS 上 localhost 优先解析为 IPv6 ::1，
// 而后端只监听 IPv4，代理会连接被拒返回 500（见故障记录）
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/search": "http://127.0.0.1:3000",
      "/documents": "http://127.0.0.1:3000",
      "/versions": "http://127.0.0.1:3000",
      "/eval": "http://127.0.0.1:3000",
      "/health": "http://127.0.0.1:3000",
    },
  },
});