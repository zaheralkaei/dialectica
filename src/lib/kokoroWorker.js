// Kokoro TTS runs here, off the main thread. onnxruntime-web WASM inference is
// synchronous and CPU-heavy; keeping it in a worker prevents it from freezing
// the UI and — importantly — from blocking the main thread's consumption of the
// LLM token stream.
//
// Protocol (main <-> worker):
//   main -> { type:'load', dtype, device }
//   worker -> { type:'progress', p }         (download/init progress)
//   worker -> { type:'ready' } | { type:'error', error }
//   main -> { type:'gen', id, text, voice }
//   worker -> { type:'audio', id, audio:Float32Array, sampling_rate } | { ...error }

import { KokoroTTS } from "kokoro-js";

let tts = null;

self.onmessage = async (e) => {
  const msg = e.data;

  if (msg.type === "load") {
    try {
      tts = await KokoroTTS.from_pretrained(
        "onnx-community/Kokoro-82M-v1.0-ONNX",
        {
          dtype: msg.dtype || "q8",
          device: msg.device || "wasm",
          progress_callback: (p) => self.postMessage({ type: "progress", p }),
        }
      );
      self.postMessage({ type: "ready" });
    } catch (err) {
      self.postMessage({ type: "error", error: String(err?.message || err) });
    }
    return;
  }

  if (msg.type === "gen") {
    try {
      const audio = await tts.generate(msg.text, { voice: msg.voice });
      const pcm = audio.audio; // Float32Array
      // Transfer the underlying buffer to avoid a copy.
      self.postMessage(
        { type: "audio", id: msg.id, audio: pcm, sampling_rate: audio.sampling_rate },
        [pcm.buffer]
      );
    } catch (err) {
      self.postMessage({ type: "audio", id: msg.id, error: String(err?.message || err) });
    }
  }
};
