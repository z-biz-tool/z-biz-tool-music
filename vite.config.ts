import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  clearScreen: false,
  server: {
    port: 5200,
    strictPort: false,
  },
  build: {
    target: "es2022",
    rollupOptions: {
      output: {
        /* 记谱引擎（abcjs）、合成引擎（tone）与界面库各占一块：
           改乐谱内核不该让用户重下一份排字机 */
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          if (/[/\\](abcjs)[/\\]/.test(id)) return "notation";
          if (/[/\\](tone|@tonejs|standardized-audio-context|web-audio-api)[/\\]/.test(id)) return "audio";
          if (/[/\\](antd|@ant-design|rc-[^/\\]+|@rc-component)[/\\]/.test(id)) return "ui";
          return "runtime";
        },
      },
    },
  },
});
