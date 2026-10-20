// Piper (VITS) TTS runs here, off the main thread. Voices are downloaded and
// cached in OPFS by @diffusionstudio/vits-web, but inference is driven here
// rather than through its predict(): that re-read the whole voice model from
// OPFS, rebuilt the onnxruntime session and encoded a WAV on every call (5-10 s
// a segment). Here each voice's session is built once and kept, and the raw
// PCM goes straight back. Multi-threaded onnxruntime needs the cross-origin
// isolation headers we set — see vite.config.js / netlify.toml.
//
// Protocol (main <-> worker):
//   main -> { type:'load', voices:string[] }   download missing voices + warm up (once)
//   worker -> { type:'progress', p } | { type:'ready' } | { type:'error', error }
//   main -> { type:'gen', id, text, voice }
//   worker -> { type:'start', id }   (job began — the main thread starts its timeout now)
//   worker -> { type:'audio', id, audio:Float32Array, sampling_rate, ms } | { ...error }
//   main -> { type:'flush', upTo }   drop queued jobs with id <= upTo (debate stopped)

import * as piper from "@diffusionstudio/vits-web";
// Both aliases are set up in vite.config.js: vits-web's own onnxruntime-web
// (1.18.0, matching the WASM at piper.ONNX_BASE) and its espeak phonemizer.
import * as ort from "vits-ort";
import { createPiperPhonemize } from "vits-phonemize";

ort.env.wasm.numThreads = navigator.hardwareConcurrency;
ort.env.wasm.wasmPaths = piper.ONNX_BASE;

// Serialize inference: onnxruntime sessions aren't safe to run concurrently, and
// overlapping calls just contend. One synth at a time, each returning as soon as
// it finishes so segment 1 never waits behind segment 2.
let genChain = Promise.resolve();
// Jobs at or below this id belong to a stopped debate and are skipped.
let flushUpTo = 0;
// The first synth initialises onnxruntime + the phonemizer; only pay that once.
let warmed = false;

// Run fn after everything already queued, without one failure jamming the chain.
function enqueue(fn) {
  const job = genChain.then(fn);
  genChain = job.catch(() => {});
  return job;
}

// Normalize text before synthesis. The espeak phonemizer can emit a phoneme id
// outside the model's range for some non-ASCII punctuation (smart quotes, em
// dashes, ellipses), which makes onnxruntime throw "Gather ... out of bounds"
// and drops the whole segment. Folding that punctuation to plain ASCII (and
// dropping anything still exotic) avoids it — and reads better aloud anyway.
function cleanText(text) {
  return text
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[–—]/g, ", ")
    .replace(/…/g, "...")
    .replace(/[^\x00-\x7F]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Read a voice file from vits-web's OPFS cache ("piper/<file name>"), fetching
// and caching it if missing — same layout as vits-web, so voices it downloaded
// are reused and vice versa.
async function readOrFetch(url) {
  const name = url.split("/").at(-1);
  let dir = null;
  try {
    dir = await (await navigator.storage.getDirectory()).getDirectoryHandle("piper", { create: true });
    return await (await dir.getFileHandle(name)).getFile();
  } catch {}
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${name} failed: HTTP ${res.status}`);
  const blob = await res.blob();
  if (dir) {
    try {
      const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
      await w.write(blob);
      await w.close();
    } catch (err) {
      console.warn("[TTS] piper: couldn't cache", name, err);
    }
  }
  return blob;
}

// voiceId -> Promise<{ config, session, knownIds }>, built once per voice and kept.
const voiceCache = new Map();

function getVoice(voiceId) {
  let entry = voiceCache.get(voiceId);
  if (!entry) {
    entry = (async () => {
      const path = piper.PATH_MAP[voiceId];
      if (!path) throw new Error(`unknown Piper voice ${voiceId}`);
      const t0 = performance.now();
      const config = JSON.parse(await (await readOrFetch(`${piper.HF_BASE}/${path}.json`)).text());
      const model = await (await readOrFetch(`${piper.HF_BASE}/${path}`)).arrayBuffer();
      const session = await ort.InferenceSession.create(model);
      // Phoneme ids this model was trained with. espeak can emit symbols some
      // models lack (e.g. the syllabic mark U+0329 in "certain" for en_US-ryan-high),
      // which makes onnxruntime throw "Gather ... out of bounds" and drops the segment.
      const knownIds = new Set(Object.values(config.phoneme_id_map || {}).flat());
      console.log(`[TTS] piper: ${voiceId} session ready in ${Math.round(performance.now() - t0)}ms`);
      return { config, session, knownIds };
    })();
    voiceCache.set(voiceId, entry);
    entry.catch(() => voiceCache.delete(voiceId)); // retry on the next request
  }
  return entry;
}

// The espeak phonemizer is an Emscripten module. Building one costs seconds
// (WASM compile + loading espeak data), so it's reused across calls — it's
// built with noExitRuntime, so callMain can run again. But every call leaks a
// little of its fixed memory: measured, a module aborts once the sum of
// (text length + ~150) over its calls reaches ~24k. So each module is retired
// at half that, with its replacement built in the background beforehand, and a
// call that fails anyway is retried once on a fresh module.
const PHONEMIZER_BUDGET = 12000;
const PHONEMIZER_CALL_COST = 150;
let phonemizer = null; // { mod: Promise<Module>, used }
let spare = null; // Promise<Module> being built to replace it
// A module's stdout/stderr hooks are fixed at creation; they forward to
// whichever call is running (calls are serialized by genChain).
let onOut = null;
let onErr = null;

function createPhonemizer() {
  const base = piper.WASM_BASE;
  const mod = createPiperPhonemize({
    print: (line) => onOut?.(line),
    printErr: (line) => onErr?.(line),
    locateFile: (f) => (f.endsWith(".wasm") ? `${base}.wasm` : f.endsWith(".data") ? `${base}.data` : f),
  });
  mod.catch(() => {}); // surfaced when awaited
  return mod;
}

async function phonemizeOnce(text, espeakVoice) {
  const cost = text.length + PHONEMIZER_CALL_COST;
  if (!phonemizer || phonemizer.used + cost > PHONEMIZER_BUDGET) {
    phonemizer = { mod: spare || createPhonemizer(), used: 0 };
    spare = null;
  }
  const current = phonemizer;
  current.used += cost;
  if (!spare && current.used > PHONEMIZER_BUDGET / 2) spare = createPhonemizer();
  let ids = null;
  let errText = "";
  try {
    const mod = await current.mod;
    onOut = (line) => {
      try {
        ids = JSON.parse(line).phoneme_ids;
      } catch {}
    };
    onErr = (line) => (errText += `${line}\n`);
    mod.callMain(["-l", espeakVoice, "--input", JSON.stringify([{ text }]), "--espeak_data", "/espeak-ng-data"]);
  } catch (err) {
    if (phonemizer === current) phonemizer = null;
    throw err;
  } finally {
    onOut = onErr = null;
  }
  if (!ids?.length) {
    if (phonemizer === current) phonemizer = null;
    throw new Error(`phonemizer produced no output${errText ? `: ${errText.trim()}` : ""}`);
  }
  if (errText) console.warn("[TTS] piper phonemizer:", errText.trim());
  return ids;
}

async function phonemize(text, espeakVoice) {
  try {
    return await phonemizeOnce(text, espeakVoice);
  } catch (err) {
    console.warn("[TTS] piper phonemizer failed, retrying on a fresh module:", err);
    return phonemizeOnce(text, espeakVoice);
  }
}

async function synthesize(text, voiceId) {
  const { config, session, knownIds } = await getVoice(voiceId);
  let ids = await phonemize(text, config.espeak.voice);
  if (knownIds.size) ids = ids.filter((id) => knownIds.has(id));
  const { noise_scale, length_scale, noise_w } = config.inference;
  const feeds = {
    input: new ort.Tensor("int64", BigInt64Array.from(ids, BigInt), [1, ids.length]),
    input_lengths: new ort.Tensor("int64", BigInt64Array.of(BigInt(ids.length)), [1]),
    scales: new ort.Tensor("float32", Float32Array.of(noise_scale, length_scale, noise_w), [3]),
  };
  if (Object.keys(config.speaker_id_map || {}).length) feeds.sid = new ort.Tensor("int64", BigInt64Array.of(0n), [1]);
  const { output } = await session.run(feeds);
  // Own the buffer outright so it can be transferred to the main thread.
  let audio = output.data;
  if (audio.byteOffset !== 0 || audio.byteLength !== audio.buffer.byteLength) audio = audio.slice();
  return { audio, sampling_rate: config.audio.sample_rate };
}

self.onmessage = async (e) => {
  const msg = e.data;

  if (msg.type === "flush") {
    flushUpTo = Math.max(flushUpTo, msg.upTo || 0);
    return;
  }

  if (msg.type === "load") {
    try {
      const voices = [...new Set((msg.voices || []).filter(Boolean))];
      // Download only voices that aren't cached in OPFS yet. vits-web's
      // download() always refetches, which used to re-download ~60 MB per voice
      // on every Start.
      const stored = new Set(await piper.stored().catch(() => []));
      for (const voiceId of voices) {
        if (stored.has(voiceId)) continue;
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
      // Build each voice's session now, off the critical path. This doesn't
      // need the queue (a new session doesn't disturb a running one), so a
      // Continue isn't held up by a segment still synthesizing from before Stop.
      for (const voiceId of voices) await getVoice(voiceId);
      // The first synth also inits the phonemizer WASM; pay that once, here.
      if (!warmed && voices[0]) {
        await enqueue(async () => {
          if (warmed) return;
          await synthesize("Ready.", voices[0]);
          warmed = true;
        });
      }
      self.postMessage({ type: "ready" });
    } catch (err) {
      self.postMessage({ type: "error", error: String(err?.message || err) });
    }
    return;
  }

  if (msg.type === "gen") {
    enqueue(async () => {
      if (msg.id <= flushUpTo) return; // stopped before it started; main already moved on
      self.postMessage({ type: "start", id: msg.id });
      const t0 = performance.now();
      try {
        const text = cleanText(msg.text) || msg.text;
        const { audio, sampling_rate } = await synthesize(text.trim(), msg.voice);
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
