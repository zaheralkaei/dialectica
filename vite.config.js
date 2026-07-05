import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Cross-origin isolation headers. They make `self.crossOriginIsolated` true,
// which enables SharedArrayBuffer and therefore multi-threaded onnxruntime WASM
// — that's how Kokoro synthesis stays fast on the CPU (2–4× vs single-thread)
// without touching the GPU, which WebLLM needs exclusively. COEP "credentialless"
// (not "require-corp") keeps WebLLM's cross-origin model downloads from the
// Hugging Face CDN working. The threaded onnxruntime worker loads fine in the
// production bundle; the earlier synth timeouts were a concurrency bug in our
// worker (now serialized), not the threading itself.
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
