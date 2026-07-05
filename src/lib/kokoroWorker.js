// Kokoro TTS runs here, off the main thread. Inference is heavy (WASM) or GPU
// (WebGPU); keeping it in a worker prevents it from freezing the UI and — more
// importantly — from blocking the main thread's consumption of the LLM token
// stream.
//
// Protocol (main <-> worker):
//   main -> { type:'load', dtype, device }
//   worker -> { type:'progress', p }                     (download/init progress)
//   worker -> { type:'ready', device } | { type:'error', error }
//   main -> { type:'gen', id, text, voice }
//   worker -> { type:'audio', id, audio:Float32Array, sampling_rate, ms } | { ...error }

import { KokoroTTS } from "kokoro-js";

let tts = null;

// A single onnxruntime InferenceSession is NOT safe to call concurrently: two
// overlapping tts.generate() runs contend on the same session and (depending on
// backend/build) either roughly double each other's latency or wedge until the
// caller times out. And overlap absolutely happens here — a turn's first
// segment is submitted mid-stream and its second at end-of-stream, well within
// the time a synth takes. So we funnel every gen through a promise chain:
// exactly one inference at a time, each returning at full speed the moment it
// finishes (segment 1 doesn't have to wait behind segment 2).
let genChain = Promise.resolve();

// Load the model on a specific backend AND prove the full inference path works
// by running a tiny warm-up synth. Weights loading succeeding is not enough —
// a backend (e.g. WebGPU with an unsupported op/dtype) can load fine yet throw
// at generate() time. Validating here lets the caller safely fall back. The
// warm-up also pays onnxruntime's one-time cold-start cost off the critical
// path, so the first real segment of the debate isn't the slow one.
async function loadOn(device, dtype) {
  const t = await KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", {
    dtype,
    device,
    progress_callback: (p) => self.postMessage({ type: "progress", p }),
  });
  await t.generate("Ready.", { voice: "af_heart" }); // warm-up + validation
  return t;
}

self.onmessage = async (e) => {
  const msg = e.data;

  if (msg.type === "load") {
    const dtype = msg.dtype || "q8";
    const preferred = msg.device || "wasm";
    // Prefer the fast backend (usually WebGPU). If it fails to load OR fails the
    // warm-up inference, fall back to WASM, which works everywhere. WASM is
    // slower but reliable — better a slow voice than none.
    try {
      tts = await loadOn(preferred, dtype);
      self.postMessage({ type: "ready", device: preferred });
    } catch (err1) {
      if (preferred !== "wasm") {
        try {
          tts = await loadOn("wasm", dtype);
          self.postMessage({
            type: "ready",
            device: "wasm",
            fellBackFrom: preferred,
            reason: String(err1?.message || err1),
          });
        } catch (err2) {
          self.postMessage({ type: "error", error: String(err2?.message || err2) });
        }
      } else {
        self.postMessage({ type: "error", error: String(err1?.message || err1) });
      }
    }
    return;
  }

  if (msg.type === "gen") {
    // Chain onto the previous generate so runs never overlap. The catch keeps
    // one failed segment from breaking the chain for everything after it.
    genChain = genChain.then(async () => {
      const t0 = performance.now();
      try {
        const audio = await tts.generate(msg.text, { voice: msg.voice });
        const pcm = audio.audio; // Float32Array
        // Transfer the underlying buffer to avoid a copy.
        self.postMessage(
          {
            type: "audio",
            id: msg.id,
            audio: pcm,
            sampling_rate: audio.sampling_rate,
            ms: Math.round(performance.now() - t0),
          },
          [pcm.buffer]
        );
      } catch (err) {
        self.postMessage({ type: "audio", id: msg.id, error: String(err?.message || err) });
      }
    });
  }
};
