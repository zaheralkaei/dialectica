// Piper TTS backend (neural voices, synthesized in a Web Worker).
//
// Shared turn interface — implemented here and by webSpeechTts.js, so the debate
// loop doesn't care which engine is active:
//
//   const prep = backend.prepareTurn({ voice, label });
//   prep.push(deltaText);              // feed streaming LLM text; synthesis starts NOW
//   await prep.firstReady;             // something is ready to be heard
//   const done = prep.play(onReveal);  // starts playing; keeps going as segments arrive
//   prep.finishInput({ dropTail });    // no more text coming
//   await done;   prep.cancel();
//
// Playback streams: it starts with the first synthesized segment and picks up
// later ones as they finish, so a slow turn no longer makes the listener wait
// for the whole thing. Synthesis runs in piperWorker.js — onnxruntime WASM on
// the main thread would freeze the UI and stall the LLM token stream.

import { log } from "./logger.js";

const SENTENCE_RE = /[^.!?…\n]+[.!?…]+["'”’)]*|\n+/g;

// Sentences are grouped into segments before synthesis: longer segments give
// better prosody and fewer seams. The FIRST segment is kept short so the first
// audio of a turn arrives quickly; later ones synthesize while it plays.
const FIRST_SEGMENT_CHARS = 90;
const MIN_SEGMENT_CHARS = 240;

// Synth watchdogs. The budget only starts when the worker actually STARTS a job
// (it acks with 'start'), so time spent queued behind other segments no longer
// counts against it — that used to time segments out on slower machines.
const synthBudgetMs = (chars) => Math.min(90000, 20000 + chars * 120);
const QUEUE_TIMEOUT_MS = 180000; // a job that never starts at all (dead worker)

export class TTSBackend {
  constructor(worker, ctx = null) {
    this.worker = worker;
    // The AudioContext is created and resumed by the caller inside the click
    // handler — browsers only allow audio after a user gesture.
    this.ctx = ctx;
    this.ownsCtx = !ctx;
    this.reqId = 0;
    this.pending = new Map(); // request id -> { resolve, chars, timer }
    this.worker.addEventListener("message", (e) => {
      const m = e.data;
      const p = this.pending.get(m.id);
      if (!p) return;
      if (m.type === "start") {
        clearTimeout(p.timer);
        p.timer = setTimeout(() => this._timeout(m.id, "synthesis"), synthBudgetMs(p.chars));
      } else if (m.type === "audio") {
        if (m.error) log("WARN", `synth error for request ${m.id}: ${m.error}`);
        p.resolve(m.error ? null : m); // null = skipped in playback
      }
    });
  }

  // Create the worker and pre-download + warm up the given voices.
  static async load({ voices = [], onProgress, audioCtx = null } = {}) {
    const worker = new Worker(new URL("./piperWorker.js", import.meta.url), { type: "module" });
    const backend = new TTSBackend(worker, audioCtx);
    try {
      await backend.prepareVoices(voices, onProgress);
    } catch (e) {
      worker.terminate();
      throw e;
    }
    return backend;
  }

  // Make sure these voices are cached and the engine is warm. Cheap when they
  // already are, so the backend is reused across debates instead of spawning a
  // new worker (and re-downloading every voice) on each Start.
  prepareVoices(voices, onProgress) {
    return new Promise((resolve, reject) => {
      const onMsg = (e) => {
        const m = e.data;
        if (m.type === "progress") onProgress?.(m.p);
        else if (m.type === "ready" || m.type === "error") {
          this.worker.removeEventListener("message", onMsg);
          if (m.type === "ready") {
            log("TTS", "Piper voices ready");
            resolve();
          } else reject(new Error(m.error));
        }
      };
      this.worker.addEventListener("message", onMsg);
      this.worker.postMessage({ type: "load", voices });
    });
  }

  // Map each debater's voice preference to what prepareTurn() needs.
  cast(prefs) {
    return prefs;
  }

  _audioCtx() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.ownsCtx = true;
    }
    if (this.ctx.state === "suspended") this.ctx.resume();
    return this.ctx;
  }

  _timeout(id, phase) {
    const p = this.pending.get(id);
    if (!p) return;
    log("WARN", `synth request ${id} timed out (${phase}) — skipping that segment`);
    p.resolve(null);
  }

  // Synthesize one segment in the worker. Always resolves: PCM on success, null
  // on error / timeout / cancel (the segment is then skipped).
  synth(text, voice) {
    const id = ++this.reqId;
    return new Promise((resolve) => {
      const entry = {
        chars: text.length,
        timer: setTimeout(() => this._timeout(id, "never started"), QUEUE_TIMEOUT_MS),
        resolve: (v) => {
          clearTimeout(entry.timer);
          this.pending.delete(id);
          resolve(v);
        },
      };
      this.pending.set(id, entry);
      this.worker.postMessage({ type: "gen", id, text, voice });
    });
  }

  prepareTurn({ voice, label = "turn" }) {
    return new PreparedTurn(this, voice, label);
  }

  // Stop: drop every queued synthesis job so the next debate doesn't wait behind
  // a stopped one, and release whoever is waiting on them.
  cancelAll() {
    this.worker.postMessage({ type: "flush", upTo: this.reqId });
    for (const p of [...this.pending.values()]) p.resolve(null);
  }

  dispose() {
    this.cancelAll();
    if (this.ctx && this.ownsCtx) {
      try {
        this.ctx.close();
      } catch {}
      this.ctx = null;
    }
    try {
      this.worker.terminate();
    } catch {}
  }
}

// One debater's turn. Text pushed during LLM generation is grouped into
// segments and synthesized right away, so audio is produced WHILE the LLM is
// still writing. play() can start as soon as the first segment exists.
class PreparedTurn {
  constructor(backend, voice, label = "turn") {
    this.backend = backend;
    this.voice = voice;
    this.label = label; // e.g. "Turn 1 (A · The Philosopher)" — tags console logs
    this.ctx = backend._audioCtx();
    this.buffer = ""; // incoming text not yet split into sentences
    this.segment = ""; // whole sentences accumulating toward one segment
    this.sentences = []; // text of each submitted segment (revealed in play())
    this.chunks = []; // Promise<{ audio, sampling_rate } | null> per segment
    this.sources = new Set();
    this.timers = [];
    this.nextTime = 0; // next start time on the audio clock (gapless play)
    this.inputDone = false;
    this.canceled = false;
    this.firstReady = new Promise((r) => (this._firstReadyResolve = r));
    this._canceledP = new Promise((r) => (this._cancelResolve = r));
    this._waiter = null; // play() parks here while waiting for the next segment
  }

  _notify() {
    const w = this._waiter;
    this._waiter = null;
    w?.();
  }

  _submit(segment) {
    const clean = segment.trim();
    if (!clean || this.canceled) return;
    const n = this.sentences.push(clean);
    log("TTS", `${this.label}: synthesizing seg ${n} (${clean.length} chars)…`);
    const p = this.backend.synth(clean, this.voice);
    p.then((res) => {
      if (this.canceled) return;
      if (res?.audio) log("TTS", `${this.label}: seg ${n} done in ${res.ms}ms`);
      else log("WARN", `${this.label}: seg ${n} produced no audio (skipped)`);
    });
    this.chunks.push(p);
    this._firstReadyResolve();
    this._notify();
  }

  _addSentence(sentence) {
    const clean = sentence.trim();
    if (!clean) return;
    this.segment = this.segment ? `${this.segment} ${clean}` : clean;
    const threshold = this.chunks.length === 0 ? FIRST_SEGMENT_CHARS : MIN_SEGMENT_CHARS;
    if (this.segment.length >= threshold) {
      this._submit(this.segment);
      this.segment = "";
    }
  }

  push(delta) {
    if (this.canceled || this.inputDone) return;
    this.buffer += delta;
    let match;
    let lastIndex = 0;
    SENTENCE_RE.lastIndex = 0;
    while ((match = SENTENCE_RE.exec(this.buffer)) !== null) {
      this._addSentence(match[0]);
      lastIndex = SENTENCE_RE.lastIndex;
    }
    if (lastIndex > 0) this.buffer = this.buffer.slice(lastIndex);
  }

  // No more text. `dropTail` (the turn hit the token cap) discards an
  // unfinished trailing sentence instead of speaking a cut-off fragment.
  finishInput({ dropTail = false } = {}) {
    if (this.inputDone) return;
    const tail = this.buffer.trim();
    this.buffer = "";
    const hasContent = this.chunks.length > 0 || this.segment;
    if (tail && !(dropTail && hasContent)) this.segment = this.segment ? `${this.segment} ${tail}` : tail;
    if (this.segment) this._submit(this.segment);
    this.segment = "";
    this.inputDone = true;
    if (!this.canceled) log("TTS", `${this.label}: ${this.sentences.length} segment(s) submitted`);
    this._firstReadyResolve();
    this._notify();
  }

  // Play segments in order on the Web Audio clock (back-to-back, no gaps),
  // waiting for each one only if it isn't synthesized yet. onReveal fires as
  // each segment becomes audible, keeping the transcript in sync with the voice.
  async play(onReveal) {
    if (this.canceled) return;
    this.nextTime = this.ctx.currentTime;
    let shown = "";
    let lastSrc = null;
    let i = 0;
    log("PLAY", `${this.label}: now speaking`);

    while (!this.canceled) {
      if (i >= this.chunks.length) {
        if (this.inputDone) break;
        await Promise.race([new Promise((r) => (this._waiter = r)), this._canceledP]);
        continue;
      }
      const res = await Promise.race([this.chunks[i], this._canceledP.then(() => null)]);
      if (this.canceled) return;

      shown = shown ? `${shown} ${this.sentences[i]}` : this.sentences[i];
      const segNo = i + 1;
      i++;
      if (res?.audio) {
        const { startAt, src } = this._schedule(res.audio, res.sampling_rate);
        lastSrc = src;
        const reveal = shown;
        const delayMs = Math.max(0, (startAt - this.ctx.currentTime) * 1000);
        this.timers.push(
          setTimeout(() => {
            if (this.canceled) return;
            log("PLAY", `${this.label}: seg ${segNo} audible`);
            onReveal?.(reveal);
          }, delayMs)
        );
      } else {
        onReveal?.(shown);
      }
    }

    // Resolve once the last scheduled segment has finished — or on cancel, or
    // after a safety timeout if 'ended' never fires (e.g. iOS interrupts audio).
    if (lastSrc && !this.canceled) {
      const remainingMs = Math.max(0, (this.nextTime - this.ctx.currentTime) * 1000);
      await Promise.race([
        new Promise((resolve) => {
          lastSrc.addEventListener("ended", resolve, { once: true });
          if (this.ctx.currentTime >= this.nextTime) resolve();
        }),
        new Promise((resolve) => setTimeout(resolve, remainingMs + 3000)),
        this._canceledP,
      ]);
    }
    if (!this.canceled) log("PLAY", `${this.label}: finished speaking`);
  }

  // Queue one segment to start the moment the previous one ends.
  _schedule(float32, sampleRate) {
    const ctx = this.ctx;
    const buf = ctx.createBuffer(1, float32.length, sampleRate);
    buf.copyToChannel(float32, 0);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    const startAt = Math.max(ctx.currentTime, this.nextTime);
    src.start(startAt);
    this.nextTime = startAt + buf.duration;
    this.sources.add(src);
    src.addEventListener("ended", () => this.sources.delete(src), { once: true });
    return { startAt, src };
  }

  cancel() {
    if (this.canceled) return;
    this.canceled = true;
    this._cancelResolve();
    this._firstReadyResolve();
    this._notify();
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    for (const src of this.sources) {
      try {
        src.stop();
      } catch {}
    }
    this.sources.clear();
  }
}
