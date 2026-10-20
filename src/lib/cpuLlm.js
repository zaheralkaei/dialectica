// Main-thread adapter for the Lite CPU engine (cpuLlmWorker.js). It exposes the
// same surface the debate loop uses on a WebLLM engine — chat.completions.create
// with streaming, interruptGenerate(), unload() — so the two are interchangeable.

export async function createCpuEngine(onProgress) {
  const worker = new Worker(new URL("./cpuLlmWorker.js", import.meta.url), { type: "module" });

  // transformers.js reports progress per file; fold it into one overall
  // fraction shaped like WebLLM's { progress: 0..1, text }.
  const files = new Map();
  const report = (p) => {
    if (p?.status === "progress" && p.file) {
      files.set(p.file, { loaded: p.loaded || 0, total: p.total || 0 });
      let loaded = 0;
      let total = 0;
      for (const f of files.values()) {
        loaded += f.loaded;
        total += f.total;
      }
      const frac = total ? loaded / total : 0;
      // "Loading", not "Downloading": progress is also reported when the model
      // is read back from the on-device cache.
      onProgress?.({ progress: frac, text: `Loading Lite CPU model… ${Math.round(frac * 100)}%` });
    } else if (p?.status === "ready") {
      onProgress?.({ progress: 1, text: "Starting Lite CPU model…" });
    }
  };

  await new Promise((resolve, reject) => {
    const onMsg = (e) => {
      const m = e.data;
      if (m.type === "progress") report(m.p);
      else if (m.type === "ready" || m.type === "error") {
        worker.removeEventListener("message", onMsg);
        m.type === "ready" ? resolve() : reject(new Error(m.error));
      }
    };
    worker.addEventListener("message", onMsg);
    worker.postMessage({ type: "load" });
  }).catch((e) => {
    worker.terminate();
    throw e;
  });

  let reqId = 0;

  function stream({ messages, max_tokens, temperature }) {
    const id = ++reqId;
    const queue = [];
    let done = false;
    let wake = null;
    const onMsg = (e) => {
      const m = e.data;
      if (m.id !== id) return;
      if (m.type === "token") queue.push({ choices: [{ delta: { content: m.text } }] });
      else if (m.type === "done") {
        queue.push({ choices: [{ delta: {}, finish_reason: m.finish_reason }] });
        done = true;
      } else if (m.type === "error") {
        queue.push({ error: m.error });
        done = true;
      }
      wake?.();
    };
    worker.addEventListener("message", onMsg);
    worker.postMessage({ type: "generate", id, messages, max_tokens, temperature });

    return (async function* () {
      try {
        while (true) {
          if (queue.length) {
            const c = queue.shift();
            if (c.error) throw new Error(c.error);
            yield c;
            continue;
          }
          if (done) return;
          await new Promise((r) => (wake = r));
          wake = null;
        }
      } finally {
        worker.removeEventListener("message", onMsg);
      }
    })();
  }

  return {
    chat: { completions: { create: async (opts) => stream(opts) } },
    interruptGenerate() {
      worker.postMessage({ type: "interrupt", upTo: reqId });
    },
    async unload() {
      worker.terminate();
    },
  };
}
