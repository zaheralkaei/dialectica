import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Cross-origin isolation headers. They make `self.crossOriginIsolated` true,
// which enables SharedArrayBuffer and therefore multi-threaded onnxruntime WASM
// — that's how Piper synthesis stays fast on the CPU without touching the GPU,
// which WebLLM needs exclusively. COEP "credentialless" (not "require-corp")
// keeps cross-origin fetches working: WebLLM's models from the Hugging Face CDN,
// and Piper's onnxruntime + phonemizer WASM from their CDNs.
const coiHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "credentialless",
};

export default defineConfig({
  plugins: [react()],
  // These ship large WASM/worker assets; exclude from dep pre-bundling so Vite
  // serves their internal workers/wasm correctly in dev.
  optimizeDeps: {
    exclude: ["@mlc-ai/web-llm", "kokoro-js", "@diffusionstudio/vits-web"],
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
