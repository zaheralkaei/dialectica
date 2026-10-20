// "Lite" CPU LLM: a small instruct model run with transformers.js on WASM, for
// browsers without WebGPU. Much slower than WebLLM and less eloquent, but it
// works everywhere, so the app is never just a dead "WebGPU required" screen.
//
// Protocol (main <-> worker):
//   main -> { type:'load' }
//   worker -> { type:'progress', p } | { type:'ready' } | { type:'error', error }
//   main -> { type:'generate', id, messages, max_tokens, temperature }
//   worker -> { type:'token', id, text } … { type:'done', id, finish_reason } | { type:'error', id, error }
//   main -> { type:'interrupt', upTo }   stop the running request and drop queued ones with id <= upTo

import { pipeline, TextStreamer, InterruptableStoppingCriteria, env } from "@huggingface/transformers";

const MODEL = "onnx-community/Qwen2.5-0.5B-Instruct";

env.allowLocalModels = false;

// Cache model files in the Origin Private File System instead of Cache Storage.
// Chromium refuses to store a single ~500 MB response in Cache Storage
// ("Failed to execute 'put' on 'Cache': Unexpected internal error"), so the
// model was silently re-downloaded on every visit. OPFS handles large files and
// writes them as a stream. createWritable() writes to a swap file that is only
// committed when the stream closes, so an interrupted download never leaves a
// truncated model behind. Where OPFS writing isn't supported, put() fails and
// transformers.js just logs a warning and carries on without a cache.
async function opfsFile(key, create) {
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle("transformers-cache", { create: true });
  const name = String(key).replace(/^https?:\/\//, "").replace(/[^\w.-]/g, "_").slice(-200);
  return dir.getFileHandle(name, { create });
}
const opfsCache = {
  async match(key) {
    try {
      const file = await (await opfsFile(key, false)).getFile();
      if (!file.size) return undefined; // left empty by an interrupted write
      return new Response(file, { headers: { "content-length": String(file.size) } });
    } catch {
      return undefined;
    }
  },
  async put(key, response) {
    const writable = await (await opfsFile(key, true)).createWritable();
    await response.body.pipeTo(writable); // closes (commits) on success, aborts on error
  },
};
if (navigator.storage?.getDirectory) {
  env.useBrowserCache = false;
  env.useCustomCache = true;
  env.customCache = opfsCache;
}

let generator = null;
const stopping = new InterruptableStoppingCriteria();
let cancelUpTo = 0;
// One generation at a time — a session can't run two concurrently.
let chain = Promise.resolve();

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === "load") load();
  else if (msg.type === "interrupt") {
    cancelUpTo = Math.max(cancelUpTo, msg.upTo || 0);
    stopping.interrupt();
  } else if (msg.type === "generate") {
    chain = chain.then(() => generate(msg));
  }
};

async function load() {
  try {
    generator = await pipeline("text-generation", MODEL, {
      // 8-bit, not 4-bit: for this repo the q4 file is actually the LARGER
      // download (786 MB vs 512 MB — it keeps full-precision embeddings), and
      // 4-bit visibly degrades a 0.5B model (it drifted into chatbot filler
      // instead of debating). 8-bit stays close to the original model.
      dtype: "q8",
      device: "wasm",
      progress_callback: (p) => self.postMessage({ type: "progress", p }),
    });
    self.postMessage({ type: "ready" });
  } catch (err) {
    self.postMessage({ type: "error", error: String(err?.message || err) });
  }
}

async function generate({ id, messages, max_tokens = 160, temperature = 0.8 }) {
  if (id <= cancelUpTo) {
    self.postMessage({ type: "done", id, finish_reason: "abort" });
    return;
  }
  stopping.reset();
  let tokens = 0;
  const streamer = new TextStreamer(generator.tokenizer, {
    skip_prompt: true,
    skip_special_tokens: true,
    callback_function: (text) => self.postMessage({ type: "token", id, text }),
    token_callback_function: () => {
      tokens++;
    },
  });
  try {
    await generator(messages, {
      max_new_tokens: max_tokens,
      do_sample: temperature > 0,
      temperature,
      top_p: 0.9,
      repetition_penalty: 1.1,
      streamer,
      stopping_criteria: stopping,
    });
    const reason = id <= cancelUpTo ? "abort" : tokens >= max_tokens ? "length" : "stop";
    self.postMessage({ type: "done", id, finish_reason: reason });
  } catch (err) {
    self.postMessage({ type: "error", id, error: String(err?.message || err) });
  }
}
