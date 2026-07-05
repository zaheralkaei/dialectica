import { useRef, useState, useCallback } from "react";
import { MODELS, DEFAULT_MODEL, getEngine, streamTurn, isWebGPUAvailable } from "./lib/llm.js";
import { buildTurnPrompt } from "./lib/debate.js";
import { TTSBackend } from "./lib/tts.js";
import { log } from "./lib/logger.js";
import { PRESET_CHARACTERS, VOICES, makeCharacter } from "./config/characters.js";
import { PRESET_TOPICS, randomTopic } from "./config/topics.js";
import DebaterCard from "./components/DebaterCard.jsx";
import Transcript from "./components/Transcript.jsx";

const PHASES = { SETUP: "setup", LOADING: "loading", DEBATING: "debating", DONE: "done" };

// Most transcript bubbles kept on screen at once (indefinite debates would
// otherwise grow the DOM forever).
const MAX_BUBBLES = 40;

// Module-level guard so a second debate can never run concurrently with one
// already in flight (a component-ref guard could be defeated by a remount).
let debateActive = false;

export default function App() {
  const [phase, setPhase] = useState(PHASES.SETUP);
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [topic, setTopic] = useState(PRESET_TOPICS[0]);
  const [turns, setTurns] = useState(6);
  const [infinite, setInfinite] = useState(false);
  const [charA, setCharA] = useState(() => makeCharacter(PRESET_CHARACTERS[0], "for"));
  const [charB, setCharB] = useState(() => makeCharacter(PRESET_CHARACTERS[1], "against"));

  const [transcript, setTranscript] = useState([]);
  const [status, setStatus] = useState("");
  const [progress, setProgress] = useState(0);
  const [activeSpeaker, setActiveSpeaker] = useState(null); // "A" | "B" | null
  const [error, setError] = useState("");

  const runningRef = useRef(false);
  const ttsRef = useRef(null);
  const audioCtxRef = useRef(null);
  const sessionRef = useRef(null); // the turn currently PLAYING
  const prefetchRef = useRef(null); // the next turn being PREPARED silently
  const engineRef = useRef(null);
  const idRef = useRef(0);

  const webgpu = isWebGPUAvailable();

  const appendEntry = useCallback((speaker, char) => {
    const id = ++idRef.current;
    // Cap the rendered transcript so an indefinite debate can't grow the DOM
    // without bound — older bubbles scroll off and are dropped.
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

  async function ensureTTS() {
    setStatus("Loading Piper voices…");
    log("TTS", `Loading Piper voices: ${charA.voice}, ${charB.voice}…`);
    // Piper (VITS) is a much lighter neural TTS than Kokoro — it runs on the CPU
    // (multi-threaded onnxruntime via the cross-origin isolation headers), so the
    // GPU stays entirely with WebLLM. We pre-download just the two debaters'
    // voices so nothing stalls mid-debate fetching a model.
    return TTSBackend.load({
      voices: [charA.voice, charB.voice],
      audioCtx: audioCtxRef.current,
      onProgress: (p) => {
        if (p?.progress != null) setProgress(Math.round(p.progress));
        if (p?.status) setStatus(`Piper: ${p.file || p.status} ${p.progress ? Math.round(p.progress) + "%" : ""}`);
      },
    });
  }

  async function start() {
    // Re-entrancy guard: never let a second debate loop run while one is already
    // in flight, or two loops would generate and PLAY over each other.
    if (debateActive) return;
    debateActive = true;
    runningRef.current = true;

    // Unlock audio NOW, synchronously inside the click handler. Browsers only
    // let an AudioContext produce sound after a user gesture; if we waited until
    // the first turn is synthesized (many seconds later, after model downloads)
    // the gesture is long gone and playback stays silent. Creating + resuming it
    // here — still within the click — guarantees it's running when audio starts.
    try {
      if (!audioCtxRef.current) {
        audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)();
      }
      if (audioCtxRef.current.state === "suspended") audioCtxRef.current.resume();
    } catch {}

    setError("");
    if (!webgpu) {
      debateActive = false;
      runningRef.current = false;
      setError(
        "WebGPU isn't available in this browser. Use the latest Chrome or Edge (desktop) — the on-device LLM needs WebGPU."
      );
      return;
    }
    setTranscript([]);
    setPhase(PHASES.LOADING);
    log(
      "DEBATE",
      `Start · "${topic}" · ${model} · ${infinite ? "∞" : turns} turns · ${charA.name} vs ${charB.name}`
    );

    try {
      setStatus("Loading debate model… first time downloads a few hundred MB, then it's cached.");
      log("LLM", `Loading model ${model}…`);
      const engine = await getEngine(model, (r) => {
        setStatus(r.text || "Loading model…");
        if (r.progress != null) setProgress(Math.round(r.progress * 100));
      });
      engineRef.current = engine;
      log("LLM", "Model ready");

      ttsRef.current = await ensureTTS();

      setPhase(PHASES.DEBATING);
      setStatus("");
      log("DEBATE", "Everything loaded — debate begins");
      await runLoop(engine);
      setStatus("Debate complete.");
      setPhase(PHASES.DONE);
      log("DEBATE", "Complete");
    } catch (e) {
      console.error(e);
      log("WARN", `Debate aborted: ${String(e?.message || e)}`);
      setError(String(e?.message || e));
      setPhase(PHASES.SETUP);
    } finally {
      debateActive = false;
      runningRef.current = false;
      setActiveSpeaker(null);
    }
  }

  // Pipelined debate:
  //   • Each turn's audio is synthesized WHILE the LLM is still writing it
  //     (KokoroPreparedTurn.push feeds the worker per sentence).
  //   • While a debater is SPEAKING, the next debater's turn is already being
  //     generated + synthesized in the background — but nothing is printed and
  //     nothing is spoken until it's actually their turn.
  async function runLoop(engine) {
    const tts = ttsRef.current;
    const totalTurns = infinite ? Infinity : turns;
    const local = []; // running transcript used to build each prompt

    // Generate + synthesize one turn without displaying or playing it.
    // Returns everything needed to present it later.
    async function prepareTurn(turnIndex) {
      const isA = turnIndex % 2 === 0;
      const character = isA ? charA : charB;
      const opponent = isA ? charB : charA;
      const label = `Turn ${turnIndex + 1} (${isA ? "A" : "B"} · ${character.name})`;
      const { system, user } = buildTurnPrompt({
        character,
        opponent,
        topic,
        transcript: local,
        isOpening: turnIndex < 2,
      });

      const prep = tts.prepareTurn({ voice: character.voice, label });
      prefetchRef.current = prep;

      log("LLM", `${label}: generating…`);
      const genStart = performance.now();
      let text = "";
      let firstToken = false;
      for await (const delta of streamTurn(engine, system, user)) {
        if (!runningRef.current) break;
        if (!firstToken) {
          firstToken = true;
          log("LLM", `${label}: first token (${Math.round(performance.now() - genStart)}ms)`);
        }
        text += delta;
        prep.push(delta); // synth starts now, during generation
      }
      prep.finishInput();
      const words = text.trim().split(/\s+/).filter(Boolean).length;
      log("LLM", `${label}: finished — ${words} words in ${Math.round(performance.now() - genStart)}ms`);
      // Record into context so the NEXT prepared turn can rebut it. Only the last
      // few are ever used (see HISTORY_WINDOW), so trim to keep memory flat over
      // an indefinite debate.
      local.push({ speakerName: character.name, text });
      if (local.length > 6) local.splice(0, local.length - 6);
      // Deliberately DON'T wait for full synthesis here. A turn is "ready" the
      // moment its text is generated; its audio segments keep synthesizing in
      // the background and play() streams them in as it reaches them. Waiting
      // for the whole turn to synthesize is what caused the "Preparing next
      // turn…" stall: synth of a full turn can outlast the previous turn's
      // playback. Generation alone always finishes well within that playback,
      // so returning now keeps the hand-off seamless — and for every turn after
      // the opening the segments have had the entire previous turn to finish, so
      // playback is still gapless.
      return { turnIndex, speaker: isA ? "A" : "B", character, prep };
    }

    // Start preparing the very first turn. Only the opening incurs a visible
    // wait (for its text + first audio segment); every later turn is prepared in
    // the background while the previous debater is speaking.
    setStatus("Preparing opening statement (generating + synthesizing voice)…");
    let pending = prepareTurn(0);

    for (let turn = 0; turn < totalTurns; turn++) {
      // While we wait for this turn to be ready, nobody is speaking — clear the
      // glow so it never lingers on a debater who has gone silent. If the turn
      // is already prepared (the common case), this "wait" is instant.
      if (turn > 0) {
        setActiveSpeaker(null);
        setStatus("Preparing next turn…");
      }
      const waitStart = performance.now();
      const cur = await pending; // its text + audio are ready
      if (!runningRef.current) break;
      const waitMs = Math.round(performance.now() - waitStart);
      if (turn > 0 && waitMs > 150) {
        log("DEBATE", `waited ${waitMs}ms for Turn ${turn + 1} to be ready (pipeline behind)`);
      }

      // Kick off the NEXT turn now, so it prepares while this one speaks.
      if (turn + 1 < totalTurns) {
        log("DEBATE", `prefetching Turn ${turn + 2} in the background`);
        pending = prepareTurn(turn + 1);
      }

      // Present the current turn: reveal its bubble and play its voice. The glow
      // is on ONLY for the duration of play() — i.e. only while audio is heard.
      setStatus("");
      setActiveSpeaker(cur.speaker);
      const entryId = appendEntry(cur.speaker, cur.character);
      sessionRef.current = cur.prep;

      // play() reveals each segment's text as its audio begins.
      await cur.prep.play((revealed) => updateEntry(entryId, revealed));
      if (!runningRef.current) break;
    }
  }

  function stop() {
    if (runningRef.current) log("DEBATE", "Stop requested — interrupting generation & audio");
    debateActive = false;
    runningRef.current = false;
    // Breaking the for-await does NOT stop WebLLM's decode loop — we must
    // explicitly interrupt it, or the engine stays busy and the next debate
    // queues behind a request that never ends.
    try {
      engineRef.current?.interruptGenerate();
    } catch {}
    sessionRef.current?.cancel();
    prefetchRef.current?.cancel();
    ttsRef.current?.cancel();
    setActiveSpeaker(null);
    setStatus("Stopped.");
    setPhase(PHASES.DONE);
  }

  function reset() {
    stop();
    setTranscript([]);
    setPhase(PHASES.SETUP);
    setStatus("");
  }

  const busy = phase === PHASES.LOADING || phase === PHASES.DEBATING;

  return (
    <div className="app">
      <header className="hero">
        <h1>
          🗣️ Dialectica
        </h1>
        <p className="tagline">Two AI minds debate any topic — with streaming voices, entirely in your browser.</p>
      </header>

      {!webgpu && (
        <div className="banner warn">
          ⚠️ WebGPU not detected. The on-device LLM needs it — try the latest Chrome or Edge.
        </div>
      )}
      {error && <div className="banner error">{error}</div>}

      <div className="stage">
        <DebaterCard
          side="A"
          label="For the topic"
          character={charA}
          onChange={setCharA}
          presets={PRESET_CHARACTERS}
          voices={VOICES}
          active={activeSpeaker === "A"}
          disabled={busy}
        />

        <div className="vs">VS</div>

        <DebaterCard
          side="B"
          label="Against the topic"
          character={charB}
          onChange={setCharB}
          presets={PRESET_CHARACTERS}
          voices={VOICES}
          active={activeSpeaker === "B"}
          disabled={busy}
        />
      </div>

      <div className="controls">
        <label className="field topic">
          <span>Debate topic</span>
          <div className="topic-row">
            <input
              type="text"
              value={topic}
              disabled={busy}
              onChange={(e) => setTopic(e.target.value)}
              placeholder="Type a topic, or pick one →"
            />
            <button className="ghost" disabled={busy} onClick={() => setTopic(randomTopic())} title="Random topic">
              🎲
            </button>
          </div>
          <select
            disabled={busy}
            value=""
            onChange={(e) => e.target.value && setTopic(e.target.value)}
          >
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
            <span>Model (WebGPU)</span>
            <select value={model} disabled={busy} onChange={(e) => setModel(e.target.value)}>
              {MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
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
              disabled={busy || infinite}
              onChange={(e) => setTurns(Number(e.target.value))}
            />
            <label className="checkline">
              <input
                type="checkbox"
                checked={infinite}
                disabled={busy}
                onChange={(e) => setInfinite(e.target.checked)}
              />
              <span>Debate indefinitely (until you press Stop)</span>
            </label>
          </label>
        </div>

        <div className="actions">
          {phase === PHASES.SETUP || phase === PHASES.DONE ? (
            <button className="primary" onClick={start} disabled={!webgpu}>
              ▶ Start debate
            </button>
          ) : (
            <button className="danger" onClick={stop}>
              ■ Stop
            </button>
          )}
          {transcript.length > 0 && !busy && (
            <button className="ghost" onClick={reset}>
              ↺ Reset
            </button>
          )}
        </div>
      </div>

      {(busy || status) && (
        <div className="status">
          {phase === PHASES.LOADING && (
            <div className="progressbar">
              <div className="fill" style={{ width: `${progress}%` }} />
            </div>
          )}
          <span>{status}</span>
        </div>
      )}

      <Transcript entries={transcript} activeSpeaker={activeSpeaker} />

      <footer className="foot">
        Runs 100% in your browser · No backend · No API keys · Models cached after first load
      </footer>
    </div>
  );
}
