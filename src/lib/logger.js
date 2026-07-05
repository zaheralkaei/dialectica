// Real-time pipeline logger. Every stage of a debate — model loading, LLM
// generation, TTS synthesis, and audio playback — logs through here so the whole
// flow is visible live in the browser console, each line tagged and timestamped.
//
//   +12.34s [LLM]  Turn 1 (A): generated 63 words
//   +12.41s [TTS]  Turn 1 (A): synth seg 1 done in 2980ms
//   +15.02s [PLAY] Turn 1 (A): now speaking
//
// Filter the console by a tag (LLM / TTS / PLAY / DEBATE) to isolate one stage.

const START = performance.now();

const TAG_COLOR = {
  DEBATE: "#d98cc4",
  LLM: "#5aa9e6",
  TTS: "#4f9d8c",
  PLAY: "#e0a15b",
  WARN: "#e0585b",
};

function stamp() {
  return `+${((performance.now() - START) / 1000).toFixed(2)}s`;
}

// log(tag, message, ...extra) — tag drives the color; extra args are passed
// straight to console.log (so objects stay inspectable).
export function log(tag, msg, ...extra) {
  const color = TAG_COLOR[tag] || "#8b7fd6";
  console.log(
    `%c${stamp()} %c${tag}%c ${msg}`,
    "color:#999",
    `color:${color};font-weight:700`,
    "color:inherit",
    ...extra
  );
}

// Printed once on load so it's obvious the live log is active and what the tags
// mean. Filter the console by a tag (e.g. "TTS") to isolate one stage.
log("DEBATE", "Live pipeline logging enabled · tags: LLM · TTS · PLAY · DEBATE · WARN");
