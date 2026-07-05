// Piper (VITS) TTS runs here, off the main thread, via @diffusionstudio/vits-web.
// vits-web pulls onnxruntime-web + the espeak phonemizer WASM from CDNs, caches
// the voice models in OPFS, and runs multi-threaded onnxruntime (needs the
// cross-origin isolation headers we set — see vite.config.js / netlify.toml).
//
// Protocol (main <-> worker):
//   main -> { type:'load', voices:string[] }   pre-download + warm up
//   worker -> { type:'progress', p } | { type:'ready' } | { type:'error', error }
//   main -> { type:'gen', id, text, voice }
//   worker -> { type:'audio', id, audio:Float32Array, sampling_rate, ms } | { ...error }

import * as piper from "@diffusionstudio/vits-web";

// Serialize inference: onnxruntime sessions aren't safe to run concurrently, and
// overlapping calls just contend. One synth at a time, each returning as soon as
// it finishes so segment 1 never waits behind segment 2.
let genChain = Promise.resolve();

// vits-web returns a standard 16-bit PCM mono WAV Blob. Decode it to the
// Float32Array + sample rate the audio pipeline schedules directly.
function wavToFloat32(buf) {
  const dv = new DataView(buf);
  const sampleRate = dv.getUint32(24, true);
  // Walk chunks to find 'data' (don't assume a fixed 44-byte header).
  let off = 12;
  let dataOff = 44;
  let dataLen = buf.byteLength - 44;
  while (off + 8 <= buf.byteLength) {
    const id =
      String.fromCharCode(dv.getUint8(off), dv.getUint8(off + 1), dv.getUint8(off + 2), dv.getUint8(off + 3));
    const size = dv.getUint32(off + 4, true);
    if (id === "data") {
      dataOff = off + 8;
      dataLen = size;
      break;
    }
    off += 8 + size;
  }
  const n = Math.floor(dataLen / 2);
  const audio = new Float32Array(n);
  for (let i = 0; i < n; i++) audio[i] = dv.getInt16(dataOff + i * 2, true) / 32768;
  return { audio, sampling_rate: sampleRate };
}

self.onmessage = async (e) => {
  const msg = e.data;

  if (msg.type === "load") {
    try {
      const voices = (msg.voices || []).filter(Boolean);
      // Pre-download the debater voices (cached in OPFS) so the debate doesn't
      // stall mid-turn fetching a model.
      for (const voiceId of voices) {
        await piper.download(voiceId, (p) =>
          self.postMessage({
            type: "progress",
            p: {
              file: voiceId,
              status: "downloading voice",
              progress: p?.total ? (p.loaded / p.total) * 100 : undefined,
            },
          })
        );
      }
      // Warm up: the first predict also fetches + inits onnxruntime and the
      // phonemizer WASM from their CDNs, so pay that off the critical path.
      if (voices[0]) await piper.predict({ text: "Ready.", voiceId: voices[0] });
      self.postMessage({ type: "ready" });
    } catch (err) {
      self.postMessage({ type: "error", error: String(err?.message || err) });
    }
    return;
  }

  if (msg.type === "gen") {
    genChain = genChain.then(async () => {
      const t0 = performance.now();
      try {
        const blob = await piper.predict({ text: msg.text, voiceId: msg.voice });
        const { audio, sampling_rate } = wavToFloat32(await blob.arrayBuffer());
        self.postMessage(
          { type: "audio", id: msg.id, audio, sampling_rate, ms: Math.round(performance.now() - t0) },
          [audio.buffer]
        );
      } catch (err) {
        self.postMessage({ type: "audio", id: msg.id, error: String(err?.message || err) });
      }
    });
  }
};
