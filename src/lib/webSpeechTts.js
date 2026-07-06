// Web Speech API TTS — the lightest possible engine: zero download, zero
// dependencies, instant. Uses the browser's built-in speechSynthesis, which
// runs natively on the main thread (no worker, no WASM, no model files).
//
// Same prepareTurn interface as the Piper backend (tts.js), so the debate
// pipeline doesn't need to know which engine is active:
//
//   const prep = backend.prepareTurn({ voice });
//   prep.push(deltaText);        // feed streaming LLM tokens (splits into sentences)
//   prep.finishInput();          // no more text coming
//   await prep.play(onReveal);   // speak sentence-by-sentence, reveal text in sync
//   prep.cancel();
//
// Unlike Piper, Web Speech can't pre-synthesize audio during LLM generation —
// but it doesn't need to: there's no model load or inference, so speaking
// starts instantly when play() is called. The sentence chunking still applies
// so the transcript reveals in sync with the voice.

import { log } from "./logger.js";

const SENTENCE_RE = /[^.!?…\n]+[.!?…]+["'”’)]*|\n+/g;

// speechSynthesis.getVoices() returns [] until the browser loads system voices
// (async on Chrome). Wait for the voiceschanged event, with a timeout fallback.
function waitForVoices(timeoutMs = 2000) {
  return new Promise((resolve) => {
    if (!("speechSynthesis" in window)) return resolve([]);
    const existing = window.speechSynthesis.getVoices();
    if (existing.length > 0) return resolve(existing);
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      window.speechSynthesis.removeEventListener("voiceschanged", finish);
      resolve(window.speechSynthesis.getVoices());
    };
    window.speechSynthesis.addEventListener("voiceschanged", finish);
    setTimeout(finish, timeoutMs);
  });
}

export class WebSpeechTTS {
  constructor(audioCtx = null) {
    // AudioContext is unused — Web Speech goes through the OS audio path, not
    // Web Audio. Kept for interface compatibility with TTSBackend.
    this.ctx = audioCtx;
  }

  static async load({ voices = [], onProgress, audioCtx = null } = {}) {
    if (!("speechSynthesis" in window)) {
      throw new Error("Web Speech API not available in this browser");
    }
    const available = await waitForVoices();
    log("TTS", `Web Speech ready — ${available.length} system voice(s) available`);
    return new WebSpeechTTS(audioCtx);
  }

  prepareTurn({ voice, label = "turn" }) {
    return new WebSpeechPreparedTurn(this, voice, label);
  }

  cancel() {
    try {
      window.speechSynthesis?.cancel();
    } catch {}
  }

  dispose() {
    this.cancel();
  }
}

// One debater's turn. Streaming LLM tokens are split into sentences (same regex
// as the Piper backend) and queued as separate SpeechSynthesisUtterance objects
// so text reveals in sync with each sentence starting to speak.
class WebSpeechPreparedTurn {
  constructor(backend, voicePref, label = "turn") {
    this.backend = backend;
    // voicePref can be:
    //   - a voiceURI string (user picked a specific voice from the dropdown)
    //   - { lang, gender } hint from the preset character
    //   - null/undefined (auto-select)
    this.voicePref = voicePref;
    this.label = label;
    this.buffer = ""; // raw incoming text not yet split into sentences
    this.sentences = []; // completed sentences to speak
    this.canceled = false;
    this._doneResolve = null;
  }

  _addSentence(sentence) {
    const clean = sentence.trim();
    if (!clean || this.canceled) return;
    this.sentences.push(clean);
  }

  // Feed streaming LLM tokens; complete sentences are extracted immediately.
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

  // No more text — fold any trailing partial sentence in.
  finishInput() {
    if (this.canceled) return;
    const tail = this.buffer.trim();
    if (tail) this.sentences.push(tail);
    this.buffer = "";
    log("TTS", `${this.label}: ${this.sentences.length} sentence(s) ready for Web Speech`);
  }

  // Web Speech doesn't pre-synthesize — nothing to wait for.
  async ready() {}

  // Resolve the voice preference to a SpeechSynthesisVoice object.
  _resolveVoice() {
    if (!("speechSynthesis" in window)) return null;
    const voices = window.speechSynthesis.getVoices();
    if (!voices.length) return null;

    const pref = this.voicePref;

    // User-selected specific voice by URI or name.
    if (typeof pref === "string" && pref) {
      const match = voices.find((v) => v.voiceURI === pref || v.name === pref);
      if (match) return match;
    }

    // Preset hint: { lang, gender }.
    if (pref && typeof pref === "object") {
      const lang = pref.lang?.toLowerCase() || "en";
      const langMatches = voices.filter((v) => v.lang.toLowerCase().startsWith(lang));
      if (langMatches.length === 0) {
        const en = voices.find((v) => v.lang.toLowerCase().startsWith("en"));
        return en || voices[0];
      }
      if (pref.gender === "female") {
        const female = langMatches.find((v) =>
          /female|woman|girl|samantha|victoria|amy|kate|zira|heather|serena|fiona|google uk english female/i.test(
            v.name
          )
        );
        if (female) return female;
      } else if (pref.gender === "male") {
        const male = langMatches.find((v) =>
          /male|man|boy|david|daniel|alex|fred|rishi|arthur|oliver|google uk english male/i.test(
            v.name
          )
        );
        if (male) return male;
      }
      return langMatches[0];
    }

    // Default: first English voice, or first available.
    const en = voices.find((v) => v.lang.toLowerCase().startsWith("en"));
    return en || voices[0];
  }

  // Queue all sentences as utterances (gapless) and resolve when the last one
  // ends. onReveal fires as each sentence starts speaking.
  async play(onReveal) {
    if (this.canceled || this.sentences.length === 0) return;
    if (!("speechSynthesis" in window)) {
      onReveal?.(this.sentences.join(" "));
      log("WARN", `${this.label}: Web Speech not available — text shown without audio`);
      return;
    }

    const synth = window.speechSynthesis;
    const voice = this._resolveVoice();

    // Stop anything currently speaking (e.g. a previous canceled turn).
    synth.cancel();

    let shown = "";
    const n = this.sentences.length;
    log("PLAY", `${this.label}: now speaking (${n} sentence(s), Web Speech)`);

    const done = new Promise((resolve) => {
      this._doneResolve = resolve;
    });

    // Chrome's speechSynthesis has a long-standing bug where it pauses after
    // ~15 seconds of continuous speaking without ever resuming. Polling
    // resume() keeps long turns (a minute+) audible. The poll stops on done.
    this._keepAlive = setInterval(() => {
      if (this.canceled) return;
      if (window.speechSynthesis.paused) window.speechSynthesis.resume();
    }, 5000);

    for (let i = 0; i < this.sentences.length; i++) {
      const text = this.sentences[i];
      shown = shown ? `${shown} ${text}` : text;

      const utterance = new SpeechSynthesisUtterance(text);
      if (voice) {
        utterance.voice = voice;
        utterance.lang = voice.lang;
      }
      utterance.rate = 1.0;

      const reveal = shown;
      const segNo = i + 1;
      const isLast = i === n - 1;

      utterance.onstart = () => {
        if (this.canceled) return;
        log("PLAY", `${this.label}: seg ${segNo}/${n} audible`);
        onReveal?.(reveal);
      };

      if (isLast) {
        utterance.onend = () => {
          if (!this.canceled) log("PLAY", `${this.label}: finished speaking`);
          clearInterval(this._keepAlive);
          this._doneResolve?.();
        };
        utterance.onerror = () => {
          clearInterval(this._keepAlive);
          this._doneResolve?.();
        };
      }

      synth.speak(utterance);
    }

    await done;
  }

  cancel() {
    this.canceled = true;
    clearInterval(this._keepAlive);
    try {
      window.speechSynthesis?.cancel();
    } catch {}
    this._doneResolve?.();
  }
}