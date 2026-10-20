import { useRef, useState, useCallback, useEffect } from "react";
import {
  MODELS,
  CPU_MODEL_ID,
  StallError,
  detectGPU,
  defaultModel,
  isConstrainedDevice,
  prefetchEngineModule,
  loadEngine,
  disposeEngine,
  isFatalEngineError,
  streamTurn,
} from "./lib/llm.js";
import { buildTurnPrompt, isEcho, NO_ECHO_RETRY } from "./lib/debate.js";
import { createSpeechFilter, dropIncompleteTail } from "./lib/speechFilter.js";
import { TTSBackend } from "./lib/tts.js";
import { WebSpeechTTS, unlockSpeech } from "./lib/webSpeechTts.js";
import { log } from "./lib/logger.js";
import { PRESET_CHARACTERS, VOICES, makeCharacter, voiceForEngine, webSpeechVoiceOptions } from "./config/characters.js";
import { PRESET_TOPICS, randomTopic } from "./config/topics.js";
import DebaterCard from "./components/DebaterCard.jsx";
import Transcript from "./components/Transcript.jsx";

const PHASES = { SETUP: "setup", LOADING: "loading", DEBATING: "debating", DONE: "done" };

// TTS engines. "webspeech" is the default — zero download, instant, uses the
// browser's built-in speechSynthesis. "piper" is the neural VITS engine
// (~20–60 MB per voice download) for higher-quality voices.
const TTS_ENGINES = [
  { id: "webspeech", label: "Web Speech (light, no download)" },
  { id: "piper", label: "Piper neural (~40 MB voices)" },
];

// Most transcript bubbles kept on screen (an indefinite debate would otherwise
// grow the DOM forever).
const MAX_BUBBLES = 40;

// How much of a turn is held back (not spoken yet) until it's confirmed not to
// be a copy of the previous turn — about a dozen words.
const ECHO_CHECK_CHARS = 70;

// --- run control -------------------------------------------------------------
// Every debate run gets its own token. Stop aborts THAT run: each await in the
// run races against its abort signal, so the loop exits immediately instead of
// finishing whatever it was waiting on. Previously one shared `running` flag
// was used for all runs, so after Stop → Start the old loop saw "running" again
// and kept playing over the new debate (and its cleanup could kill the new one).

class Aborted extends Error {
  constructor() {
    super("aborted");
    this.name = "Aborted";
  }
}

let runSeq = 0;
function createRun() {
  const run = { id: ++runSeq, aborted: false, finished: false };
  run.abortP = new Promise((resolve) => (run._fire = resolve));
  run.doneP = new Promise((resolve) => (run.markDone = resolve));
  run.abort = () => {
    if (run.aborted) return;
    run.aborted = true;
    run._fire();
  };
  return run;
}

// Await `p`, but bail out the instant the run is stopped.
async function until(run, p) {
  const value = await Promise.race([p, run.abortP]);
  if (run.aborted) throw new Aborted();
  return value;
}

function friendlyError(e) {
  const msg = String(e?.message || e);
  if (/device (was )?lost|instance reference|out of memory|\boom\b/i.test(msg))
    return "The GPU ran out of memory and the model stopped. Pick a smaller model (e.g. Llama 3.2 1B), close other heavy tabs, then press Continue.";
  if (e instanceof StallError)
    return "The model stopped responding. Press Continue to retry — or pick a smaller model if it keeps happening.";
  if (/shader-f16/i.test(msg)) return "Your GPU can't run this model build. Please pick another model.";
  if (/quota|storage/i.test(msg))
    return "The browser ran out of storage for the model cache. Free up some disk space or site data, then try again.";
  if (/fetch|network|load failed|connection/i.test(msg)) return "A download failed — check your connection and try again.";
  return msg;
}

export default function App() {
  const [phase, setPhase] = useState(PHASES.SETUP);
  const [gpu, setGpu] = useState({ checked: false, webgpu: false, f16: false });
  const [model, setModel] = useState(null); // chosen after the GPU check
  const [ttsEngine, setTtsEngine] = useState("webspeech");
  const [topic, setTopic] = useState(PRESET_TOPICS[0]);
  const [turns, setTurns] = useState(6);
  const [infinite, setInfinite] = useState(true);
  const [charA, setCharA] = useState(() => makeCharacter(PRESET_CHARACTERS[0], "for"));
  const [charB, setCharB] = useState(() => makeCharacter(PRESET_CHARACTERS[1], "against"));

  const [transcript, setTranscript] = useState([]);
  const [status, setStatus] = useState("");
  const [voiceStatus, setVoiceStatus] = useState("");
  const [progress, setProgress] = useState(0);
  const [activeSpeaker, setActiveSpeaker] = useState(null); // "A" | "B" | null
  const [error, setError] = useState("");
  const [showInfo, setShowInfo] = useState(false);

  const runRef = useRef(null); // the current (or last) debate run
  const engineRef = useRef(null);
  const ttsRef = useRef(null); // TTS backend used by the current run
  const ttsCacheRef = useRef({}); // backends reused across runs (no worker leak)
  const sessionRef = useRef(null); // the turn currently PLAYING
  const prefetchRef = useRef(null); // the next turn being PREPARED silently
  const audioCtxRef = useRef(null);
  const committedRef = useRef([]); // turns already shown — lets Continue resume
  const nextTurnRef = useRef(0);
  const wakeLockRef = useRef(null);
  const idRef = useRef(0);

  const isRunning = () => {
    const r = runRef.current;
    return !!r && !r.finished && !r.aborted;
  };

  // Probe the GPU once: decides WebGPU vs Lite CPU, f16 vs f32 model builds,
  // and a model size that fits the device.
  useEffect(() => {
    let alive = true;
    detectGPU().then((g) => {
      if (!alive) return;
      setGpu({ checked: true, ...g });
      setModel((m) => m ?? defaultModel(g));
      log(
        "DEBATE",
        `Device: ${g.webgpu ? `WebGPU${g.f16 ? "" : " without shader-f16 (using f32 model builds)"}` : "no WebGPU → Lite CPU mode"}` +
          (isConstrainedDevice() ? " · mobile / low-memory profile" : "")
      );
      if (g.webgpu) {
        const idle = window.requestIdleCallback || ((cb) => setTimeout(cb, 1500));
        idle(() => prefetchEngineModule());
      }
    });
    return () => {
      alive = false;
    };
  }, []);

  // Web Speech system voices load async; re-render the dropdowns when they arrive.
  const [, setVoicesTick] = useState(0);
  useEffect(() => {
    if (!("speechSynthesis" in window)) return;
    const bump = () => setVoicesTick((n) => n + 1);
    window.speechSynthesis.addEventListener?.("voiceschanged", bump);
    if (window.speechSynthesis.getVoices().length > 0) bump();
    return () => window.speechSynthesis.removeEventListener?.("voiceschanged", bump);
  }, []);

  // Coming back to the tab mid-debate: re-take the wake lock (the browser drops
  // it when the page is hidden) and resume audio if the OS interrupted it.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== "visible" || !isRunning()) return;
      acquireWakeLock();
      const ctx = audioCtxRef.current;
      if (ctx && ctx.state !== "running") ctx.resume?.().catch(() => {});
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  const appendEntry = useCallback((speaker, char) => {
    const id = ++idRef.current;
    setTranscript((t) =>
      [...t, { id, speaker, speakerName: char.name, emoji: char.emoji, color: char.color, text: "" }].slice(
        -MAX_BUBBLES
      )
    );
    return id;
  }, []);

  const updateEntry = useCallback((id, text) => {
    setTranscript((t) => t.map((e) => (e.id === id ? { ...e, text } : e)));
  }, []);

  const dropEmptyEntries = useCallback(() => setTranscript((t) => t.filter((e) => e.text)), []);

  // Must run synchronously inside the click: browsers only allow audio after a
  // user gesture, and our first sound comes seconds later.
  function unlockAudio() {
    try {
      if (!audioCtxRef.current) audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtxRef.current.state !== "running") audioCtxRef.current.resume()?.catch?.(() => {});
    } catch {}
  }

  // Keep a phone's screen on during a debate — when it sleeps, the browser
  // suspends audio and the GPU and the debate stalls.
  async function acquireWakeLock() {
    if (!navigator.wakeLock || wakeLockRef.current) return;
    try {
      const lock = await navigator.wakeLock.request("screen");
      wakeLockRef.current = lock;
      lock.addEventListener?.("release", () => {
        if (wakeLockRef.current === lock) wakeLockRef.current = null;
      });
    } catch {}
  }
  function releaseWakeLock() {
    const lock = wakeLockRef.current;
    wakeLockRef.current = null;
    lock?.release?.().catch?.(() => {});
  }

  // Silence everything right now: stop token generation, cancel the playing and
  // prefetched turns, drop queued synthesis, and suspend audio output.
  function haltAudio() {
    try {
      engineRef.current?.interruptGenerate();
    } catch {}
    sessionRef.current?.cancel();
    prefetchRef.current?.cancel();
    ttsRef.current?.cancelAll?.();
    try {
      if (audioCtxRef.current?.state === "running") audioCtxRef.current.suspend()?.catch?.(() => {});
    } catch {}
  }

  async function ensureTTS() {
    const cache = ttsCacheRef.current;
    if (ttsEngine === "webspeech") {
      log("TTS", "Using Web Speech (no download needed)");
      if (!cache.webspeech) cache.webspeech = WebSpeechTTS.load();
      return cache.webspeech;
    }
    const voices = [charA.voice, charB.voice];
    log("TTS", `Preparing Piper voices: ${voices.join(", ")}…`);
    const run = runRef.current;
    const onProgress = (p) => {
      if (runRef.current !== run || run?.aborted) return;
      if (p?.progress != null) setVoiceStatus(`Downloading voice ${p.file || ""} — ${Math.round(p.progress)}%`);
    };
    // One Piper worker for the whole session: it keeps its voices and warm
    // onnxruntime, so later debates start instantly.
    if (!cache.piper) {
      const pending = TTSBackend.load({ voices, audioCtx: audioCtxRef.current, onProgress });
      cache.piper = pending;
      pending.catch(() => {
        if (cache.piper === pending) cache.piper = null;
      });
      return pending;
    }
    const backend = await cache.piper;
    await backend.prepareVoices(voices, onProgress);
    return backend;
  }

  async function start(resume = false) {
    // ---- synchronous part: still inside the click ----
    if (isRunning() || !model) return;
    const topicText = topic.trim();
    if (!topicText) {
      setError("Type or pick a topic first.");
      return;
    }
    unlockAudio();
    if (ttsEngine === "webspeech") unlockSpeech();

    const prev = runRef.current;
    const run = createRun();
    runRef.current = run;
    if (resume) {
      // Pick up right after the last turn that was actually heard.
      const heard = committedRef.current.filter((r) => r.heard);
      committedRef.current = heard;
      nextTurnRef.current = heard.length ? heard[heard.length - 1].turn + 1 : 0;
    } else {
      setTranscript([]);
      committedRef.current = [];
      nextTurnRef.current = 0;
    }
    setError("");
    setStatus("");
    setVoiceStatus("");
    setProgress(0);
    setActiveSpeaker(null);
    setPhase(PHASES.LOADING);
    acquireWakeLock();

    try {
      // A run that was just stopped may still be unwinding; let it finish so the
      // two can never overlap.
      if (prev && !prev.finished) await until(run, prev.doneP);

      log(
        "DEBATE",
        `${resume ? "Continue" : "Start"} · "${topicText}" · ${model} · ${infinite ? "∞" : turns} turns · ${charA.name} vs ${charB.name}`
      );
      setStatus("Loading the debate model… the first time downloads it, then it's cached.");
      log("LLM", `Loading model ${model}…`);
      // Model and voices load in parallel — the old code waited for one, then the other.
      // Progress only updates the UI while THIS run is the one loading — a load
      // that outlives a stopped run must not overwrite "Stopped." on screen.
      const enginePromise = loadEngine(model, gpu, (r) => {
        if (runRef.current !== run || run.aborted) return;
        if (r?.text) setStatus(r.text);
        if (r?.progress != null) setProgress(Math.round(r.progress * 100));
      });
      const ttsPromise = ensureTTS();
      let ttsReady = false;
      ttsPromise.then(() => (ttsReady = true), () => {});
      // Report each half as it finishes, so the status reflects what is
      // actually still loading (often the voices, not the model).
      enginePromise.then(
        () => {
          if (runRef.current !== run || run.aborted) return;
          log("LLM", "Model ready");
          if (!ttsReady) {
            setProgress(100);
            setStatus("Model ready — preparing the voices…");
          }
        },
        () => {}
      );
      const [engine, tts] = await until(run, Promise.all([enginePromise, ttsPromise]));
      engineRef.current = engine;
      ttsRef.current = tts;

      setPhase(PHASES.DEBATING);
      setStatus("");
      setVoiceStatus("");
      log("DEBATE", "Everything loaded — debate begins");
      const completed = await runLoop(run, engine, tts, topicText);
      if (runRef.current === run) {
        setStatus(completed ? "Debate complete." : "");
        setPhase(PHASES.DONE);
        log("DEBATE", "Complete");
      }
    } catch (e) {
      if (e instanceof Aborted || run.aborted) return; // stop() already updated the UI
      console.error(e);
      log("WARN", `Debate aborted: ${String(e?.message || e)}`);
      haltAudio();
      if (isFatalEngineError(e)) {
        // The engine can't be trusted after a device loss or stall — rebuild it
        // on the next Start instead of reusing a dead one.
        engineRef.current = null;
        disposeEngine();
      }
      if (runRef.current === run) {
        dropEmptyEntries();
        setError(friendlyError(e));
        setStatus("");
        setPhase(PHASES.DONE);
      }
    } finally {
      run.finished = true;
      run.markDone();
      if (runRef.current === run) {
        setActiveSpeaker(null);
        releaseWakeLock();
      }
    }
  }

  // Pipelined debate:
  //   • A turn starts SPEAKING as soon as its first sentence/segment is ready,
  //     while the LLM is still writing the rest.
  //   • Once a turn's text is complete, the next debater's turn starts
  //     generating in the background, while the current one is still talking.
  async function runLoop(run, engine, tts, topicText) {
    const startTurn = nextTurnRef.current;
    const endTurn = infinite ? Infinity : startTurn + turns;
    // Working memory for prompts (only the last two turns are ever used).
    const history = committedRef.current.slice(-6).map(({ speakerName, text }) => ({ speakerName, text }));
    const [voiceA, voiceB] = tts.cast([voiceForEngine(charA, ttsEngine), voiceForEngine(charB, ttsEngine)]);
    let emptyStreak = 0;

    function prepareTurn(turnIndex) {
      const isA = turnIndex % 2 === 0;
      const character = isA ? charA : charB;
      const opponent = isA ? charB : charA;
      const label = `Turn ${turnIndex + 1} (${isA ? "A" : "B"} · ${character.name})`;
      const isClosing = Number.isFinite(endTurn) && turnIndex >= 2 && turnIndex >= endTurn - 2;
      const { system, user, stop } = buildTurnPrompt({
        character,
        opponent,
        topic: topicText,
        transcript: history,
        turnIndex,
        isClosing,
      });
      const prep = tts.prepareTurn({ voice: isA ? voiceA : voiceB, label });
      prefetchRef.current = prep;

      // One generation attempt. The first ECHO_CHECK_CHARS characters are held
      // back until we know the model isn't parroting the previous turn, so an
      // echo is never spoken — it's discarded and regenerated instead.
      async function attempt(userPrompt, temperature, t0) {
        const filter = createSpeechFilter({ names: [character.name, opponent.name] });
        const info = {};
        let text = "";
        let held = "";
        let checked = false;
        let echoed = false;
        let first = true;
        const release = (s) => {
          if (checked) return prep.push(s);
          held += s;
          if (held.length < ECHO_CHECK_CHARS) return;
          checked = true;
          if (isEcho(held, history)) echoed = true;
          else prep.push(held);
        };
        for await (const delta of streamTurn(engine, system, userPrompt, {
          stop,
          info,
          temperature,
          abortSignal: run.abortP,
        })) {
          if (run.aborted) break;
          if (first) {
            first = false;
            log("LLM", `${label}: first token (${Math.round(performance.now() - t0)}ms)`);
          }
          const clean = filter.push(delta);
          if (clean) {
            text += clean;
            release(clean);
          }
          if (echoed) break; // streamTurn's cleanup interrupts + drains the generation
          if (filter.stopped) {
            log("LLM", `${label}: model began scripting the next speaker — cut short`);
            break;
          }
        }
        if (run.aborted) throw new Aborted();
        if (!echoed) {
          const rest = filter.flush();
          if (rest) {
            text += rest;
            release(rest);
          }
          if (!checked) {
            checked = true;
            if (isEcho(held, history)) echoed = true;
            else if (held) prep.push(held);
          }
        }
        return { text, info, echoed };
      }

      const generated = (async () => {
        log("LLM", `${label}: generating…`);
        const t0 = performance.now();
        let { text, info, echoed } = await attempt(user, 0.8, t0);
        if (echoed) {
          log("WARN", `${label}: model repeated the previous turn — regenerating`);
          ({ text, info, echoed } = await attempt(user + NO_ECHO_RETRY, 1.0, performance.now()));
          if (echoed) {
            log("WARN", `${label}: repeated again — skipping this turn`);
            prep.finishInput();
            return "";
          }
        }
        const truncated = info.finishReason === "length";
        prep.finishInput({ dropTail: truncated });
        if (truncated) text = dropIncompleteTail(text);
        text = text.replace(/\s+/g, " ").trim();
        const words = text ? text.split(" ").length : 0;
        log(
          "LLM",
          `${label}: finished — ${words} words in ${Math.round(performance.now() - t0)}ms` +
            (truncated ? " (hit the length cap; unfinished sentence dropped)" : "")
        );
        if (text) {
          history.push({ speakerName: character.name, text });
          if (history.length > 6) history.splice(0, history.length - 6);
        }
        return text;
      })();
      // If generation fails, release whoever is waiting for this turn's audio so
      // the error surfaces instead of hanging.
      generated.catch(() => prep.finishInput());
      return { speaker: isA ? "A" : "B", character, prep, generated };
    }

    let next = prepareTurn(startTurn);
    for (let turn = startTurn; turn < endTurn; turn++) {
      const cur = next;

      // Wait until there's something to SAY — not for the whole turn. Only show
      // "Preparing…" if that wait is noticeable, so there's no flicker when the
      // prefetched turn is already ready (the common case).
      const waitStart = performance.now();
      const slow = setTimeout(() => {
        if (runRef.current !== run || run.aborted) return;
        setActiveSpeaker(null);
        setStatus(turn === 0 ? "Preparing the opening…" : "Preparing next turn…");
      }, 400);
      try {
        await until(run, cur.prep.firstReady);
      } finally {
        clearTimeout(slow);
      }
      const waitMs = Math.round(performance.now() - waitStart);
      if (turn > startTurn && waitMs > 400) log("DEBATE", `waited ${waitMs}ms for Turn ${turn + 1} (pipeline behind)`);

      setStatus("");
      setActiveSpeaker(cur.speaker);
      const entryId = appendEntry(cur.speaker, cur.character);
      sessionRef.current = cur.prep;
      // `heard` flips on the first revealed sentence. Continue resumes after the
      // last turn the user actually heard — not one that was generated but cut
      // off by Stop before a word of it played.
      const record = { turn, speaker: cur.speaker, speakerName: cur.character.name, text: "", heard: false };
      const playing = cur.prep.play((t) => {
        record.heard = true;
        updateEntry(entryId, t);
      });

      // The next turn rebuts this one, so it can only start generating once this
      // turn's text is complete — while this turn is still being spoken.
      const text = await until(run, cur.generated);
      if (text) {
        emptyStreak = 0;
        record.text = text;
        committedRef.current.push(record);
        if (committedRef.current.length > 12) committedRef.current.splice(0, committedRef.current.length - 12);
      } else {
        setTranscript((t) => t.filter((e) => e.id !== entryId));
        log("WARN", `Turn ${turn + 1}: the model produced no usable text — skipping`);
        if (++emptyStreak >= 3) throw new Error("The model produced no usable text three times in a row. Try another model.");
      }
      nextTurnRef.current = turn + 1;
      if (turn + 1 < endTurn) {
        log("DEBATE", `prefetching Turn ${turn + 2} in the background`);
        next = prepareTurn(turn + 1);
      }

      await until(run, playing);
    }
    return Number.isFinite(endTurn);
  }

  function stop() {
    const run = runRef.current;
    if (!run || run.finished || run.aborted) return;
    log("DEBATE", "Stop requested — halting generation and audio");
    run.abort();
    haltAudio();
    dropEmptyEntries();
    setActiveSpeaker(null);
    setStatus(
      committedRef.current.some((r) => r.heard) ? "Stopped. Press Continue to pick up where it left off." : "Stopped."
    );
    setVoiceStatus("");
    setPhase(PHASES.DONE);
    releaseWakeLock();
  }

  function clearDebate() {
    setTranscript([]);
    committedRef.current = [];
    nextTurnRef.current = 0;
    setStatus("");
    setError("");
    setPhase(PHASES.SETUP);
  }

  const busy = phase === PHASES.LOADING || phase === PHASES.DEBATING;
  const canResume = !busy && transcript.length > 0;
  const ready = gpu.checked && !!model;
  const liteMode = gpu.checked && !gpu.webgpu;
  const speakerName = activeSpeaker === "A" ? charA.name : activeSpeaker === "B" ? charB.name : null;
  const dockText =
    phase === PHASES.LOADING
      ? `${status || "Loading…"}`
      : speakerName
      ? `${speakerName} is speaking`
      : status || "Thinking…";

  return (
    <div className={`app${busy ? " busy" : ""}`}>
      <header className="hero">
        <div className="hero-row">
          <h1>🗣️ Dialectica</h1>
          <button
            className="info-btn"
            onClick={() => setShowInfo(true)}
            title="How does this work?"
            aria-label="About this app"
          >
            ℹ
          </button>
        </div>
        <p className="tagline">Two AI minds debate any topic — with streaming voices, entirely in your browser.</p>
      </header>

      {liteMode && (
        <div className="banner warn">
          ⚡ WebGPU isn't available in this browser, so Dialectica runs in <strong>Lite CPU mode</strong> — a
          smaller, slower model. For the full experience use a recent Chrome, Edge or Safari.
        </div>
      )}
      {error && <div className="banner error">{error}</div>}

      <div className={`stage${busy ? " compact" : ""}`}>
        <DebaterCard
          side="A"
          label="For the topic"
          character={charA}
          onChange={setCharA}
          presets={PRESET_CHARACTERS}
          voices={VOICES}
          ttsEngine={ttsEngine}
          webVoices={webSpeechVoiceOptions}
          active={activeSpeaker === "A"}
          disabled={busy}
          compact={busy}
        />

        <div className="vs">VS</div>

        <DebaterCard
          side="B"
          label="Against the topic"
          character={charB}
          onChange={setCharB}
          presets={PRESET_CHARACTERS}
          voices={VOICES}
          ttsEngine={ttsEngine}
          webVoices={webSpeechVoiceOptions}
          active={activeSpeaker === "B"}
          disabled={busy}
          compact={busy}
        />
      </div>

      <div className="controls">
        {busy ? (
          <div className="topic-now">
            <span>Topic</span>
            <p>{topic}</p>
          </div>
        ) : (
          <>
            <label className="field topic">
              <span>Debate topic</span>
              <div className="topic-row">
                <input
                  type="text"
                  value={topic}
                  onChange={(e) => setTopic(e.target.value)}
                  placeholder="Type a topic, or pick one →"
                  enterKeyHint="go"
                />
                <button className="ghost" onClick={() => setTopic(randomTopic())} title="Random topic" aria-label="Random topic">
                  🎲
                </button>
              </div>
              <select value="" onChange={(e) => e.target.value && setTopic(e.target.value)}>
                <option value="">Prepared topics…</option>
                {PRESET_TOPICS.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>

            <div className="settings">
              <label className="field">
                <span>Model</span>
                <select value={model || ""} disabled={!gpu.checked} onChange={(e) => setModel(e.target.value)}>
                  {!gpu.checked && <option value="">Checking your device…</option>}
                  {MODELS.map((m) => (
                    <option key={m.id} value={m.id} disabled={gpu.checked && !gpu.webgpu && m.id !== CPU_MODEL_ID}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="field">
                <span>Voice engine</span>
                <select value={ttsEngine} onChange={(e) => setTtsEngine(e.target.value)}>
                  {TTS_ENGINES.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="field">
                <span>Length: {infinite ? "∞ until you stop" : `${turns} turns`}</span>
                <input
                  type="range"
                  min="2"
                  max="12"
                  step="2"
                  value={turns}
                  disabled={infinite}
                  onChange={(e) => setTurns(Number(e.target.value))}
                />
                <label className="checkline">
                  <input type="checkbox" checked={infinite} onChange={(e) => setInfinite(e.target.checked)} />
                  <span>Debate indefinitely (until you press Stop)</span>
                </label>
              </label>
            </div>

            <div className="actions">
              {canResume ? (
                <>
                  <button className="primary" onClick={() => start(true)} disabled={!ready}>
                    ▶ Continue debate
                  </button>
                  <button className="ghost" onClick={() => start(false)} disabled={!ready}>
                    ↻ New debate
                  </button>
                  <button className="ghost" onClick={clearDebate} title="Clear the transcript">
                    Clear
                  </button>
                </>
              ) : (
                <button className="primary" onClick={() => start(false)} disabled={!ready}>
                  {gpu.checked ? "▶ Start debate" : "Checking your device…"}
                </button>
              )}
            </div>
          </>
        )}
      </div>

      {(phase === PHASES.LOADING || (!busy && status)) && (
        <div className="status">
          {phase === PHASES.LOADING && (
            <div className="progressbar">
              <div className="fill" style={{ width: `${progress}%` }} />
            </div>
          )}
          <span>{status}</span>
          {voiceStatus && <span className="voice-status">{voiceStatus}</span>}
        </div>
      )}

      <Transcript entries={transcript} />

      <footer className="foot">
        Runs 100% in your browser · No backend · No API keys · Models cached after first load
        <br />
        Designed and implemented by{" "}
        <a href="https://github.com/zaheralkaei" target="_blank" rel="noopener noreferrer" className="author-link">
          Zaher Alkaei
        </a>
      </footer>

      {busy && (
        <div className="dock" role="region" aria-label="Debate controls">
          <span className={`dock-dot${speakerName ? " live" : ""}`} aria-hidden />
          <span className="dock-text">{dockText}</span>
          <button className="danger" onClick={stop}>
            ■ Stop
          </button>
        </div>
      )}

      {showInfo && (
        <div className="modal-overlay" onClick={() => setShowInfo(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <button className="modal-close" onClick={() => setShowInfo(false)} aria-label="Close">
              ✕
            </button>
            <h2>How Dialectica works</h2>
            <p>
              Two AI debaters — each with its own persona and voice — take turns arguing a topic you
              choose. Everything runs <strong>100% in your browser</strong>: no backend, no API keys,
              no server costs. The LLM and the voices never leave your device.
            </p>
            <ul>
              <li>
                <strong>LLM:</strong> A small instruction-tuned language model runs on-device via{" "}
                <em>WebGPU</em> using WebLLM (Llama 3.2 3B by default, 1B on phones). One engine serves
                both debaters; the system prompt is swapped each turn. Without WebGPU, a{" "}
                <em>Lite CPU</em> model runs instead, so it works in any modern browser. Models are
                downloaded once and cached.
              </li>
              <li>
                <strong>Voice:</strong> Each sentence is spoken as soon as it's written. The default{" "}
                <em>Web Speech</em> engine uses your browser's built-in voices — zero download, instant.
                The optional <em>Piper</em> neural engine (~40 MB per voice) sounds more natural and runs on
                the CPU so the GPU stays with the LLM.
              </li>
              <li>
                <strong>Pipeline:</strong> While one debater speaks, the next one is already writing,
                keeping the back-and-forth snappy. Memory is limited to the last two turns, so a debate can
                run indefinitely without slowing down. Stop halts everything instantly; Continue resumes.
              </li>
            </ul>
            <h3>Disclaimer</h3>
            <p className="disclaimer">
              The arguments are generated by a small language model running locally and are for
              entertainment and demonstration purposes only. They may be <strong>historically,
              logically, or scientifically inaccurate</strong>, and may contain <strong>hallucinated
              facts</strong> (confident but false claims). <strong>Offensive language</strong> may also
              occur despite the safety guardrails built into the model. Do not rely on these arguments
              for factual claims, and verify anything you hear against trusted sources. The views
              expressed are not those of the author.
            </p>
            <p className="credit">
              Designed and implemented by{" "}
              <a href="https://github.com/zaheralkaei" target="_blank" rel="noopener noreferrer" className="author-link">
                Zaher Alkaei
              </a>
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
