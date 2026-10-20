import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// piperWorker.js drives Piper inference itself (to cache the ONNX session per
// voice) using two pieces of @diffusionstudio/vits-web that it doesn't export:
//  - "vits-ort": the onnxruntime-web copy vits-web depends on (1.18.0, nested
//    under its own node_modules). Its JS must match the 1.18.0 WASM vits-web
//    loads from cdnjs; the top-level onnxruntime-web is a different version
//    (pulled in by @huggingface/transformers).
//  - "vits-phonemize": the espeak phonemizer factory, which only lives in
//    vits-web's hashed internal chunk (dist/piper-<hash>.js).
// Both are resolved here so a vits-web upgrade that moves them fails the build
// loudly instead of silently breaking Piper.
function vitsWebAliases() {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const vitsDir = path.join(root, "node_modules/@diffusionstudio/vits-web");
  const ortDir = path.join(vitsDir, "node_modules/onnxruntime-web");
  const ortVersion = fs.existsSync(ortDir)
    ? JSON.parse(fs.readFileSync(path.join(ortDir, "package.json"), "utf8")).version
    : "missing";
  if (ortVersion !== "1.18.0") {
    throw new Error(
      `vits-web's nested onnxruntime-web is ${ortVersion}, piperWorker.js expects 1.18.0 — update vitsWebAliases() and the worker`
    );
  }
  const distDir = path.join(vitsDir, "dist");
  const chunks = fs.readdirSync(distDir).filter((f) => /^piper-.*\.js$/.test(f));
  if (chunks.length !== 1) {
    throw new Error(`vits-web phonemizer chunk not found (dist/piper-*.js: ${chunks.join(", ") || "none"})`);
  }
  return {
    "vits-ort": path.join(ortDir, "dist/esm/ort.min.js"),
    "vits-phonemize": path.join(distDir, chunks[0]),
  };
}

// Cross-origin isolation headers. They make `self.crossOriginIsolated` true,
// which enables SharedArrayBuffer and therefore multi-threaded onnxruntime WASM
// — that's how CPU-side inference (Piper voices, the Lite CPU model) stays fast
// without touching the GPU, which WebLLM needs exclusively. COEP
// "credentialless" (not "require-corp") keeps cross-origin fetches working:
// models from Hugging Face, and onnxruntime + phonemizer WASM from CDNs.
const coiHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "credentialless",
};

export default defineConfig({
  plugins: [react()],
  resolve: { alias: vitsWebAliases() },
  // These ship large WASM/worker assets; exclude from dep pre-bundling so Vite
  // serves their internal workers/wasm correctly in dev.
  optimizeDeps: {
    exclude: ["@mlc-ai/web-llm", "@huggingface/transformers", "@diffusionstudio/vits-web", "vits-ort", "vits-phonemize"],
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
