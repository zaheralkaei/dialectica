// Web Speech API TTS — the lightest engine: zero download, zero dependencies,
// instant. Uses the browser's built-in speechSynthesis (OS voices).
//
// Same turn interface as the Piper backend (see tts.js). Sentences are spoken
// as soon as the LLM finishes each one, so a turn starts talking long before
// it's fully generated.
//
// speechSynthesis is notoriously flaky across browsers, and every quirk below
// used to be able to hang the debate forever:
//   • Chrome drops `onend` for utterances that get garbage-collected → we keep
//     references until the turn ends.
//   • Some engines go silent without firing end/error → a watchdog notices the
//     synth is idle with sentences outstanding and moves on.
//   • A machine with no installed voices never speaks at all → text-only mode,
//     paced at reading speed.
//   • iOS/Android only allow speech after it was first used inside a tap →
//     unlockSpeech() is called from the Start click.

import { log } from "./logger.js";

const SENTENCE_RE = /[^.!?…\n]+[.!?…]+["'”’)]*|\n+/g;
const WORDS_PER_SEC = 2.6; // speaking-rate estimate for pacing and watchdogs

const synthOrNull = () => (typeof window !== "undefined" && "speechSynthesis" in window ? window.speechSynthesis : null);

// getVoices() returns [] until the browser has loaded them (async in Chrome).
function waitForVoices(timeoutMs = 2500) {
  return new Promise((resolve) => {
    const synth = synthOrNull();
    if (!synth) return resolve([]);
    const existing = synth.getVoices();
    if (existing.length > 0) return resolve(existing);
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      synth.removeEventListener?.("voiceschanged", finish);
      resolve(synth.getVoices());
    };
    synth.addEventListener?.("voiceschanged", finish);
    setTimeout(finish, timeoutMs);
  });
}

// Must be called synchronously inside a user gesture (the Start click). Mobile
// browsers refuse to speak until speechSynthesis was used from a tap, and our
// first real sentence arrives many seconds later.
export function unlockSpeech() {
  const synth = synthOrNull();
  if (!synth) return;
  try {
    const u = new SpeechSynthesisUtterance(" ");
    u.volume = 0;
    synth.speak(u);
  } catch {}
}

const FEMALE_RE =
  /female|woman|samantha|victoria|karen|moira|tessa|fiona|serena|kate|zira|aria|jenny|libby|sonia|hazel|susan|heather|amy|emma|ava|allison|natasha|catherine/i;
const MALE_RE =
  /\bmale\b|\bman\b|daniel|david|alex|fred|oliver|arthur|rishi|george|guy|ryan|thomas|james|mark|aaron|gordon|christopher|eric|liam|william/i;

// Resolve a preference — { uri, hint: { lang, gender } } — to a system voice,
// avoiding `avoid` (the other debater's voice) unless the user explicitly chose
// the same one.
function pickVoice(voices, pref, avoid) {
  if (!voices.length) return null;
  const uri = typeof pref === "string" ? pref : pref?.uri;
  if (uri) {
    const exact = voices.find((v) => v.voiceURI === uri || v.name === uri);
    if (exact) return exact;
  }
  const hint = (typeof pref === "object" && pref?.hint) || {};
  const lang = (hint.lang || "en").toLowerCase();
  const norm = (v) => v.lang.toLowerCase().replace("_", "-");
  let pool = voices.filter((v) => norm(v).startsWith(lang));
  if (!pool.length) pool = voices.filter((v) => norm(v).startsWith("en"));
  if (!pool.length) pool = voices;
  const others = pool.filter((v) => v !== avoid);
  const candidates = others.length ? others : pool;
  if (hint.gender === "female") {
    const v = candidates.find((x) => FEMALE_RE.test(x.name));
    if (v) return v;
  } else if (hint.gender === "male") {
    const v = candidates.find((x) => MALE_RE.test(x.name) && !FEMALE_RE.test(x.name));
    if (v) return v;
  }
  return candidates[0];
}

export class WebSpeechTTS {
  constructor(voiceCount) {
    this.voiceCount = voiceCount;
  }

  static async load() {
    const synth = synthOrNull();
    const voices = synth ? await waitForVoices() : [];
    if (!synth) log("WARN", "Web Speech isn't available in this browser — the debate will be shown as text only");
    else if (!voices.length) log("WARN", "No system voices installed — the debate will be shown as text, paced at reading speed");
    else log("TTS", `Web Speech ready — ${voices.length} system voice(s)`);
    return new WebSpeechTTS(voices.length);
  }

  // Pick one voice per debater, making them different whenever possible (two
  // "auto" debaters used to end up with the same first English voice).
  cast(prefs) {
    const voices = synthOrNull()?.getVoices() || [];
    const a = pickVoice(voices, prefs[0], null);
    const b = pickVoice(voices, prefs[1], a);
    log("TTS", `Voices: A → ${a?.name ?? "text only"}, B → ${b?.name ?? "text only"}`);
    return [a, b];
  }

  prepareTurn({ voice, label = "turn" }) {
    return new WebSpeechPreparedTurn(voice, label);
  }

  cancelAll() {
    try {
      synthOrNull()?.cancel();
    } catch {}
  }

  dispose() {
    this.cancelAll();
  }
}

class WebSpeechPreparedTurn {
  constructor(voice, label) {
    this.voice = voice;
    this.label = label;
    this.buffer = "";
    this.sentences = [];
    this.inputDone = false;
    this.canceled = false;
    this.firstReady = new Promise((r) => (this._firstReadyResolve = r));
    this._onNew = null; // set by play(): called whenever a sentence is added / input ends
    this._finish = null;
    this._timer = null;
    this._utterances = []; // strong refs — see the GC note at the top
  }

  _add(sentence) {
    const clean = sentence.trim();
    if (!clean || this.canceled) return;
    this.sentences.push(clean);
    this._firstReadyResolve();
    this._onNew?.();
  }

  push(delta) {
    if (this.canceled || this.inputDone) return;
    this.buffer += delta;
    let match;
    let lastIndex = 0;
    SENTENCE_RE.lastIndex = 0;
    while ((match = SENTENCE_RE.exec(this.buffer)) !== null) {
      this._add(match[0]);
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
    if (tail && !(dropTail && this.sentences.length)) this._add(tail);
    this.inputDone = true;
    if (!this.canceled) log("TTS", `${this.label}: ${this.sentences.length} sentence(s) for Web Speech`);
    this._firstReadyResolve();
    this._onNew?.();
  }

  // Speak sentences as they arrive; resolve once input is done and every
  // sentence has been spoken (or skipped by the watchdog). onReveal fires as
  // each sentence starts, keeping the transcript in sync with the voice.
  play(onReveal) {
    if (this.canceled) return Promise.resolve();
    const synth = synthOrNull();
    const speakable = !!synth && synth.getVoices().length > 0;
    log("PLAY", `${this.label}: now speaking${speakable ? "" : " (text only)"}`);

    return new Promise((resolve) => {
      let queued = 0; // sentences handed to the synth (or the pacer)
      let ended = 0; // sentences finished
      let revealedTo = -1;
      let lastProgress = performance.now();
      let finished = false;

      const reveal = (i) => {
        if (i <= revealedTo || this.canceled) return;
        revealedTo = i;
        log("PLAY", `${this.label}: sentence ${i + 1} audible`);
        onReveal?.(this.sentences.slice(0, i + 1).join(" "));
      };

      const finish = () => {
        if (finished) return;
        finished = true;
        clearInterval(watchdog);
        clearTimeout(this._timer);
        this._onNew = null;
        this._finish = null;
        this._utterances = [];
        if (!this.canceled) {
          reveal(this.sentences.length - 1);
          log("PLAY", `${this.label}: finished speaking`);
        }
        resolve();
      };
      this._finish = finish;

      const maybeDone = () => {
        if (this.canceled || (this.inputDone && ended >= this.sentences.length)) finish();
      };

      // Real speech: queue every available sentence. speak() appends to the
      // engine's queue, so consecutive sentences play back-to-back.
      const speakAvailable = () => {
        while (queued < this.sentences.length && !this.canceled) {
          const i = queued++;
          const u = new SpeechSynthesisUtterance(this.sentences[i]);
          const live = this.voice && synth.getVoices().find((v) => v.voiceURI === this.voice.voiceURI);
          const voice = live || this.voice;
          if (voice) {
            u.voice = voice;
            u.lang = voice.lang;
          }
          u.onstart = () => {
            lastProgress = performance.now();
            reveal(i);
          };
          u.onend = u.onerror = () => {
            lastProgress = performance.now();
            reveal(i);
            ended = Math.max(ended, i + 1);
            maybeDone();
          };
          this._utterances.push(u);
          lastProgress = performance.now();
          synth.speak(u);
        }
        maybeDone();
      };

      // No voices: reveal one sentence at a time at a natural reading pace.
      const paceNext = () => {
        this._timer = null;
        if (this.canceled) return finish();
        if (queued < this.sentences.length) {
          const i = queued++;
          reveal(i);
          const words = this.sentences[i].split(/\s+/).length;
          this._timer = setTimeout(() => {
            ended = i + 1;
            paceNext();
          }, Math.max(1200, (words / WORDS_PER_SEC) * 1000));
        } else maybeDone();
      };

      this._onNew = speakable ? speakAvailable : () => !this._timer && paceNext();

      const watchdog = setInterval(() => {
        if (this.canceled) return finish();
        if (!speakable) return;
        if (synth.paused) synth.resume(); // Chrome occasionally pauses its queue
        const outstanding = queued - ended;
        if (outstanding <= 0) return;
        const idle = !synth.speaking && !synth.pending;
        const words = (this.sentences[ended] || "").split(/\s+/).length;
        const budget = Math.max(8000, (words / WORDS_PER_SEC) * 1000 * 2.5);
        const quietFor = performance.now() - lastProgress;
        if ((idle && quietFor > 1500) || quietFor > budget) {
          // The engine stopped reporting progress — events were lost or speech
          // got stuck. Skip ahead instead of hanging the debate.
          log("WARN", `${this.label}: speech engine went quiet — moving on`);
          if (!idle) {
            try {
              synth.cancel();
            } catch {}
          }
          reveal(queued - 1);
          ended = queued;
          maybeDone();
        }
      }, 500);

      this._onNew();
    });
  }

  cancel() {
    if (this.canceled) return;
    this.canceled = true;
    clearTimeout(this._timer);
    // Only silence the engine if THIS turn is the one speaking — canceling the
    // prefetched next turn must not cut off the current speaker.
    if (this._finish) {
      try {
        synthOrNull()?.cancel();
      } catch {}
    }
    this._firstReadyResolve();
    this._finish?.();
  }
}
