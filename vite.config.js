import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Cross-origin isolation headers. These make `self.crossOriginIsolated` true,
// which (a) enables SharedArrayBuffer and therefore multi-threaded onnxruntime
// WASM — transformers.js auto-scales Kokoro to several threads, 2–4× faster —
// and (b) is inherited by our Web Workers. COEP "credentialless" is used (not
// "require-corp") so WebLLM's cross-origin model downloads from the Hugging
// Face CDN still succeed.
const coiHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "credentialless",
};

// WebLLM and kokoro-js ship large WASM/worker assets. We exclude them from
// dep pre-bundling so Vite serves their internal workers/wasm correctly.
export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    exclude: ["@mlc-ai/web-llm", "kokoro-js"],
  },
  build: {
    target: "esnext",
    chunkSizeWarningLimit: 4000,
  },
  worker: {
    format: "es",
  },
  server: { headers: coiHeaders },
  preview: { headers: coiHeaders },
});
