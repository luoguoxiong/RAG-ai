import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 开发环境把 API 请求代理到后端 :3000，规避跨域
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/search": "http://localhost:3000",
      "/documents": "http://localhost:3000",
      "/versions": "http://localhost:3000",
      "/eval": "http://localhost:3000",
      "/health": "http://localhost:3000",
    },
  },
});