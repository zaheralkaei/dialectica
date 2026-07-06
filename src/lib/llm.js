import { CreateWebWorkerMLCEngine } from "@mlc-ai/web-llm";

// A single engine serves BOTH debaters — we just swap the system prompt each
// turn. Loading two separate models would roughly double VRAM and download
// time for no benefit, since turns are sequential anyway.

export const MODELS = [
  { id: "Qwen2.5-1.5B-Instruct-q4f16_1-MLC", label: "Qwen2.5 1.5B — fast (~1.0 GB)" },
  { id: "Llama-3.2-3B-Instruct-q4f16_1-MLC", label: "Llama 3.2 3B — balanced (~2.2 GB)" },
  { id: "Qwen2.5-3B-Instruct-q4f16_1-MLC", label: "Qwen2.5 3B — sharp (~2.0 GB)" },
  { id: "Phi-3.5-mini-instruct-q4f16_1-MLC", label: "Phi-3.5 mini — reasoning (~2.2 GB)" },
  { id: "Llama-3.2-1B-Instruct-q4f16_1-MLC", label: "Llama 3.2 1B — tiny (~0.8 GB)" },
];

export const DEFAULT_MODEL = "Llama-3.2-3B-Instruct-q4f16_1-MLC";

let enginePromise = null;
let loadedModel = null;

export function isWebGPUAvailable() {
  return typeof navigator !== "undefined" && !!navigator.gpu;
}

export async function getEngine(modelId, onProgress) {
  if (enginePromise && loadedModel === modelId) return enginePromise;
  // Model changed — drop the old promise (engine GC'd once unreferenced).
  loadedModel = modelId;
  // The engine lives in a Web Worker so token generation never blocks the main
  // thread (which needs to stay free to queue audio segments without gaps).
  const worker = new Worker(new URL("./mlcWorker.js", import.meta.url), {
    type: "module",
  });
  enginePromise = CreateWebWorkerMLCEngine(worker, modelId, {
    initProgressCallback: (r) => onProgress?.(r),
  });
  return enginePromise;
}

// Async generator of content deltas for one debate turn.
export async function* streamTurn(
  engine,
  systemPrompt,
  userPrompt,
  // Hard cap on turn length. The prompt asks for ~60 words, but LLMs aren't
  // precise about word counts and regularly run to 80-100. A token ceiling too
  // close to the target cuts the model off mid-sentence (120 tokens ≈ 90 words
  // was too tight). 200 tokens (≈150 words) gives enough headroom to finish the
  // sentence while still preventing true 200+ word rambles — which are the
  // single biggest speed hit, since longer turns are slower to both generate
  // AND synthesize, and make the pipeline fall behind.
  { temperature = 0.85, max_tokens = 200 } = {}
) {
  const chunks = await engine.chat.completions.create({
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    stream: true,
    temperature,
    max_tokens,
  });
  for await (const chunk of chunks) {
    const delta = chunk.choices?.[0]?.delta?.content;
    if (delta) yield delta;
  }
}
