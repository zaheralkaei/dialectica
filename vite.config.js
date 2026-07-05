import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// NOTE: We deliberately do NOT set cross-origin isolation (COOP/COEP) headers.
// They make `self.crossOriginIsolated` true, which would let onnxruntime spin up
// multi-threaded WASM for Kokoro — but in the *production* bundle that nested
// pthread-worker path fails to load and every synth call hangs (times out),
// leaving the debate silent. WebLLM only needs WebGPU (not isolation), so
// running Kokoro single-threaded is the reliable choice: a touch slower to
// synthesize, but it actually produces audio in a built/deployed app.

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
});
