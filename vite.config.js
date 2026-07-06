import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // ffmpeg.wasm 관련: 싱글스레드 코어를 쓰므로 COOP/COEP 헤더 불필요.
  // 멀티스레드(@ffmpeg/core-mt)로 업그레이드할 경우 아래 주석을 해제하세요.
  // (단, 애드센스 등 외부 리소스가 깨질 수 있으니 주의!)
  // server: {
  //   headers: {
  //     "Cross-Origin-Opener-Policy": "same-origin",
  //     "Cross-Origin-Embedder-Policy": "require-corp",
  //   },
  // },
  optimizeDeps: {
    exclude: ["@ffmpeg/ffmpeg", "@ffmpeg/util"],
  },
});
