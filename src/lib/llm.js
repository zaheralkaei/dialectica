// LLM engines. Two backends sit behind one tiny interface —
//   engine.chat.completions.create({ messages, stream: true, ... })  -> async iterable of chunks
//   engine.interruptGenerate()   engine.unload()
// so the debate loop never needs to know which one is running:
//
//   • WebLLM on WebGPU — fast; the default wherever a usable GPU exists.
//   • "Lite" CPU engine (transformers.js + WASM, see cpuLlm.js) — slower and a
//     much smaller model, but it runs in browsers with no WebGPU at all.
//
// Both run in Web Workers, and both are imported lazily: web-llm alone is ~6 MB
// of JavaScript, and loading it up front made the page itself slow to appear
// (painful on phones). Now it is only fetched when a debate starts (or on idle).

export const CPU_MODEL_ID = "cpu:qwen2.5-0.5b";

// Ordered big → small. Labels give rough download sizes (q4f16 weights).
export const MODELS = [
  { id: "Llama-3.2-3B-Instruct-q4f16_1-MLC", label: "Llama 3.2 3B — balanced (~2.2 GB)" },
  { id: "Qwen2.5-3B-Instruct-q4f16_1-MLC", label: "Qwen2.5 3B — sharp (~2.0 GB)" },
  { id: "Phi-3.5-mini-instruct-q4f16_1-MLC", label: "Phi-3.5 mini — reasoning (~2.2 GB)" },
  { id: "Qwen2.5-1.5B-Instruct-q4f16_1-MLC", label: "Qwen2.5 1.5B — fast (~1.0 GB)" },
  { id: "Llama-3.2-1B-Instruct-q4f16_1-MLC", label: "Llama 3.2 1B — light, good on phones (~0.9 GB)" },
  { id: "Qwen2.5-0.5B-Instruct-q4f16_1-MLC", label: "Qwen2.5 0.5B — tiny (~0.4 GB)" },
  { id: CPU_MODEL_ID, label: "Lite · CPU, works in any browser (~0.5 GB, slow)" },
];

// Prompts are bounded to the last two turns (see debate.js), so ~1k tokens is
// the most a turn ever uses. Halving the default 4096-token context shrinks the
// KV cache by 100–250 MB of VRAM — often the difference between fitting and a
// "device lost" crash on laptops and phones.
const CONTEXT_WINDOW = 2048;

// Watchdogs. A WebGPU device can stall without throwing (driver hiccup, device
// lost), which used to freeze the debate forever. The first token gets more
// time because prefill (and CPU mode on phones) is slow.
const FIRST_TOKEN_TIMEOUT_MS = 90000;
const TOKEN_GAP_TIMEOUT_MS = 30000;

export class StallError extends Error {
  constructor() {
    super("The model stopped responding.");
    this.name = "StallError";
  }
}

// --- device capability -------------------------------------------------------

// navigator.gpu existing isn't enough: requestAdapter() returns null on
// blocklisted GPUs, and many mobile / older GPUs lack `shader-f16`, which every
// q4f16 model needs. Probe once and pick models accordingly.
export async function detectGPU() {
  if (typeof navigator === "undefined" || !navigator.gpu) return { webgpu: false, f16: false };
  try {
    const adapter = await Promise.race([
      navigator.gpu.requestAdapter(),
      new Promise((resolve) => setTimeout(() => resolve(null), 4000)),
    ]);
    if (!adapter) return { webgpu: false, f16: false };
    return { webgpu: true, f16: adapter.features.has("shader-f16") };
  } catch {
    return { webgpu: false, f16: false };
  }
}

// Phones and low-memory machines can't hold a 3B model (the tab gets killed or
// the GPU device is lost), so they default to a 1B one.
export function isConstrainedDevice() {
  if (typeof navigator === "undefined") return false;
  const mobile =
    navigator.userAgentData?.mobile ?? /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || "");
  const mem = navigator.deviceMemory; // GB, Chromium only (capped at 8)
  return mobile || (typeof mem === "number" && mem <= 4);
}

export function defaultModel(gpu) {
  if (!gpu.webgpu) return CPU_MODEL_ID;
  return isConstrainedDevice() ? "Llama-3.2-1B-Instruct-q4f16_1-MLC" : "Llama-3.2-3B-Instruct-q4f16_1-MLC";
}

// Every model ships a q4f32 twin for GPUs without shader-f16.
export function resolveModelId(modelId, gpu) {
  if (modelId === CPU_MODEL_ID || gpu.f16) return modelId;
  return modelId.replace("q4f16_1", "q4f32_1");
}

// Warm the browser cache with the web-llm module while the user is still
// choosing a topic, so pressing Start begins the model download immediately.
// Skipped on data-saver / constrained devices.
export function prefetchEngineModule() {
  if (isConstrainedDevice() || navigator.connection?.saveData) return;
  import("@mlc-ai/web-llm").catch(() => {});
}

// --- engine lifecycle --------------------------------------------------------

let current = null; // { key, promise, worker?, engine? }

export async function loadEngine(modelId, gpu, onProgress) {
  const key = resolveModelId(modelId, gpu);
  if (current?.key === key) {
    // A load may still be in flight from a stopped run — keep it, and route its
    // progress to the new caller.
    current.onProgress = onProgress;
    return current.promise;
  }

  // Switching models: release the old one first. Before, it stayed resident,
  // so two models shared VRAM and the GPU device was lost.
  await disposeEngine();

  const entry = { key, onProgress };
  const report = (r) => entry.onProgress?.(r);
  entry.promise = (async () => {
    if (key === CPU_MODEL_ID) {
      const { createCpuEngine } = await import("./cpuLlm.js");
      return createCpuEngine(report);
    }
    const { CreateWebWorkerMLCEngine } = await import("@mlc-ai/web-llm");
    entry.worker = new Worker(new URL("./mlcWorker.js", import.meta.url), { type: "module" });
    return CreateWebWorkerMLCEngine(
      entry.worker,
      key,
      { initProgressCallback: report },
      { context_window_size: CONTEXT_WINDOW }
    );
  })();
  current = entry;
  entry.promise.then(
    (engine) => (entry.engine = engine),
    () => {
      // Never cache a failed load: the next Start must retry from scratch
      // instead of instantly re-throwing the old error.
      if (current === entry) current = null;
      try {
        entry.worker?.terminate();
      } catch {}
    }
  );
  return entry.promise;
}

// Unload the current model and kill its worker. Terminating the worker is what
// reliably frees GPU memory (and also aborts a download still in progress).
export async function disposeEngine() {
  const entry = current;
  current = null;
  if (!entry) return;
  if (entry.engine) {
    await Promise.race([entry.engine.unload?.().catch(() => {}), new Promise((r) => setTimeout(r, 2000))]);
  }
  try {
    entry.worker?.terminate();
  } catch {}
}

// Errors after which the engine can't be trusted and must be rebuilt.
export function isFatalEngineError(e) {
  const msg = String(e?.message || e);
  return e instanceof StallError || /device (was )?lost|instance reference|out of memory|\boom\b/i.test(msg);
}

// --- generation --------------------------------------------------------------

// Stream one debate turn. Yields text deltas; fills `info.finishReason`
// ("stop" | "length" | "abort"). Stops promptly when `abortSignal` (a promise)
// settles, and throws StallError if the model goes silent.
export async function* streamTurn(
  engine,
  systemPrompt,
  userPrompt,
  {
    // Turn-length ceiling. The prompt asks for ~60 words; this caps rambling at
    // roughly 120. A turn that hits the cap has its unfinished last sentence
    // dropped by the caller, so the cap never produces a cut-off sentence.
    max_tokens = 160,
    temperature = 0.8,
    stop,
    info = {},
    abortSignal,
  } = {}
) {
  const chunks = await engine.chat.completions.create({
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    stream: true,
    temperature,
    max_tokens,
    // Gentle penalties discourage a turn from repeating its own phrases.
    presence_penalty: 0.2,
    frequency_penalty: 0.2,
    ...(stop?.length ? { stop } : {}),
  });

  const it = chunks[Symbol.asyncIterator]();
  const aborted = abortSignal ? abortSignal.then(() => ({ aborted: true })) : null;
  let first = true;
  let finished = false;
  let pending = null; // an it.next() that a race abandoned (abort / stall)
  try {
    while (true) {
      let timer;
      const stall = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new StallError()), first ? FIRST_TOKEN_TIMEOUT_MS : TOKEN_GAP_TIMEOUT_MS);
      });
      const next = it.next();
      pending = next;
      let r;
      try {
        r = await Promise.race(aborted ? [next, stall, aborted] : [next, stall]);
      } finally {
        clearTimeout(timer);
      }
      if (r.aborted) {
        info.finishReason = "abort";
        return;
      }
      pending = null;
      if (r.done) {
        finished = true;
        return;
      }
      first = false;
      const choice = r.value?.choices?.[0];
      if (choice?.finish_reason) info.finishReason = choice.finish_reason;
      const delta = choice?.delta?.content;
      if (delta) yield delta;
    }
  } finally {
    // Ended early (Stop, a stall, or the caller broke out of the loop)? Then
    // the generation must still be wound down properly. WebLLM's worker only
    // advances a stream when the page pulls the next chunk, and it releases the
    // model lock only once the stream completes — so an abandoned stream stays
    // parked forever holding that lock, and the NEXT request (Continue / a new
    // debate) waits on it indefinitely. Interrupt, then keep pulling until it
    // ends; after an interrupt that takes only a chunk or two.
    if (!finished) {
      try {
        engine.interruptGenerate();
      } catch {}
      drain(it, pending);
    }
  }
}

// Pull a stream to completion in the background, ignoring its output.
async function drain(it, pending) {
  try {
    if (pending && (await pending).done) return;
    for (let i = 0; i < 2000; i++) if ((await it.next()).done) return;
  } catch {}
}
