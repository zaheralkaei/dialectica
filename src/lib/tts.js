// Streaming Kokoro TTS, run in a Web Worker.
//
// Two-phase design. It lets us PREPARE a debater's turn — run the LLM and
// synthesize the audio — while the *previous* debater is still speaking, then
// PLAY it on cue with the text revealed in sync:
//
//   const prep = backend.prepareTurn(voice);
//   prep.push(deltaText);        // feed streaming LLM tokens; synthesis starts NOW
//   prep.finishInput();          // no more text coming
//   await prep.play(onReveal);   // play buffered audio; reveal text sentence-by-sentence
//   prep.cancel();
//
// Synthesis runs off the main thread in kokoroWorker.js — kokoro-js runs
// onnxruntime WASM, which would freeze the UI (and stall the LLM token stream)
// if run on the main thread. The main thread only schedules the returned PCM.

const SENTENCE_RE = /[^.!?…\n]+[.!?…]+["'”’)]*|\n+/g;

// We don't synthesize one sentence at a time — we group whole sentences into a
// segment until it reaches this many characters, then send the segment to the
// worker as a single generate() call. Longer segments give Kokoro more context
// for natural prosody; the first one costs a bit more latency, but while it
// plays the next segments finish generating, so the pipeline hides that cost.
// Tune this to trade first-audio latency (lower) vs. prosody/fewer seams (higher).
const MIN_SEGMENT_CHARS = 240;

// Safety net: if the worker never returns a segment (crash, unexpected state),
// give up on it after this long so a single segment can't stall the debate.
const SYNTH_TIMEOUT_MS = 30000;

export class KokoroBackend {
  constructor(worker) {
    this.worker = worker;
    this.ctx = null;
    this.reqId = 0;
    this.pending = new Map(); // request id -> { resolve }
    this.worker.addEventListener("message", (e) => {
      const m = e.data;
      if (m.type !== "audio") return;
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      // A failed segment resolves null (skipped in playback) rather than
      // rejecting, so one bad segment can't abort the turn.
      if (m.error) {
        console.warn(`Kokoro synth error for segment ${m.id}: ${m.error}`);
        p.resolve(null);
      } else {
        p.resolve(m); // { audio: Float32Array, sampling_rate }
      }
    });
  }

  static async load({ dtype = "q8", device = "wasm", onProgress } = {}) {
    const worker = new Worker(new URL("./kokoroWorker.js", import.meta.url), {
      type: "module",
    });
    await new Promise((resolve, reject) => {
      const onMsg = (e) => {
        const m = e.data;
        if (m.type === "progress") onProgress?.(m.p);
        else if (m.type === "ready") {
          worker.removeEventListener("message", onMsg);
          resolve();
        } else if (m.type === "error") {
          worker.removeEventListener("message", onMsg);
          reject(new Error(m.error));
        }
      };
      worker.addEventListener("message", onMsg);
      worker.postMessage({ type: "load", dtype, device });
    });
    return new KokoroBackend(worker);
  }

  _audioCtx() {
    if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (this.ctx.state === "suspended") this.ctx.resume();
    return this.ctx;
  }

  // Fire off synthesis of one segment in the worker. Returns a promise for its
  // PCM. Calls pipeline in the worker and are processed in order. A generous
  // timeout guarantees a stuck/crashed worker can never hang the whole debate —
  // a timed-out segment resolves as null and is simply skipped in playback.
  synth(text, voice) {
    const id = ++this.reqId;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          console.warn(`Kokoro synth timed out for segment ${id}`);
          resolve(null);
        }
      }, SYNTH_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
      });
      this.worker.postMessage({ type: "gen", id, text, voice });
    });
  }

  prepareTurn({ kokoroVoice = "af_heart" }) {
    return new KokoroPreparedTurn(this, kokoroVoice);
  }

  cancel() {
    if (this.ctx) {
      try {
        this.ctx.close();
      } catch {}
      this.ctx = null;
    }
  }

  dispose() {
    this.cancel();
    try {
      this.worker.terminate();
    } catch {}
  }
}

// One debater's turn. Text pushed in during LLM generation is chunked into
// sentences and synthesized immediately (in the worker) — so audio is being
// produced WHILE the LLM is still writing. play() is called later, on cue.
class KokoroPreparedTurn {
  constructor(backend, voice) {
    this.backend = backend;
    this.voice = voice;
    this.ctx = backend._audioCtx();
    this.buffer = ""; // raw incoming text not yet split into sentences
    this.segment = ""; // completed sentences accumulating toward one segment
    this.sentences = []; // text of each submitted segment (revealed in play())
    this.chunks = []; // Promise<{ audio, sampling_rate }> per segment, in order
    this.sources = new Set();
    this.timers = []; // pending text-reveal timeouts
    this.nextTime = 0; // next start time on the audio clock (for gapless play)
    this.canceled = false;
  }

  // Send one finished segment (one or more sentences) to the worker to synthesize.
  _submit(segment) {
    const clean = segment.trim();
    if (!clean || this.canceled) return;
    this.sentences.push(clean);
    this.chunks.push(this.backend.synth(clean, this.voice)); // synthesis starts now
  }

  // Accumulate a completed sentence into the current segment; flush to the
  // worker once the segment is long enough for good prosody.
  _addSentence(sentence) {
    const clean = sentence.trim();
    if (!clean) return;
    this.segment = this.segment ? `${this.segment} ${clean}` : clean;
    if (this.segment.length >= MIN_SEGMENT_CHARS) {
      this._submit(this.segment);
      this.segment = "";
    }
  }

  // Feed streaming LLM tokens; complete sentences accumulate into segments and
  // each full segment is synthesized as soon as it's long enough.
  push(delta) {
    if (this.canceled) return;
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

  // No more text will arrive — fold any trailing partial sentence into the
  // pending segment and flush it.
  finishInput() {
    if (this.canceled) return;
    const tail = this.buffer.trim();
    if (tail) this.segment = this.segment ? `${this.segment} ${tail}` : tail;
    this.buffer = "";
    if (this.segment) {
      this._submit(this.segment);
      this.segment = "";
    }
  }

  // Resolve once EVERY segment has been synthesized. Call finishInput() first.
  // A fully-synthesized turn plays perfectly gaplessly (all buffers ready), and
  // because a turn is prepared during the previous turn's playback, this wait
  // is hidden for every turn after the first.
  async ready() {
    await Promise.allSettled(this.chunks);
  }

  // Play the (pre)synthesized audio in order, scheduling each segment on the
  // Web Audio clock so they run back-to-back with NO gaps — even if the main
  // thread is briefly busy (e.g. generating the next turn). onReveal fires as
  // each segment actually begins, keeping the transcript in sync with the voice.
  async play(onReveal) {
    this.nextTime = this.ctx.currentTime;
    let shown = "";
    let lastSrc = null;

    for (let i = 0; i < this.chunks.length; i++) {
      if (this.canceled) return;
      let res;
      try {
        res = await this.chunks[i]; // usually already resolved (synthesized ahead)
      } catch {
        res = null;
      }
      if (this.canceled) return;

      shown = shown ? `${shown} ${this.sentences[i]}` : this.sentences[i];
      if (res?.audio) {
        const { startAt, src } = this._schedule(res.audio, res.sampling_rate);
        lastSrc = src;
        // Reveal this segment's text exactly when its audio starts.
        const reveal = shown;
        const delayMs = Math.max(0, (startAt - this.ctx.currentTime) * 1000);
        this.timers.push(setTimeout(() => !this.canceled && onReveal?.(reveal), delayMs));
      } else {
        onReveal?.(shown);
      }
    }

    // Resolve only after the last scheduled segment has actually finished.
    if (lastSrc && !this.canceled) {
      await new Promise((resolve) => {
        lastSrc.addEventListener("ended", resolve, { once: true });
        // Guard: if it somehow already ended, don't hang.
        if (this.ctx.currentTime >= this.nextTime) resolve();
      });
    }
  }

  // Queue one segment to start the moment the previous one ends (or now, if we
  // fell behind). Returns immediately — playback happens on the audio thread.
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
    this.canceled = true;
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
