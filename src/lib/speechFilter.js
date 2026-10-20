// Streaming cleanup of LLM output before it is spoken and shown.
//
// Small models regularly slip out of "spoken words only":
//   "The Firebrand: Let me tell you…"      → a name label (would be read aloud)
//   "*leans forward* Listen closely…"      → a stage direction
//   "**This** is wrong (laughs)"           → markdown, an action in parentheses
//   "…that's final.\nThe Scientist: But…"  → the model writing its opponent's turn
// The filter removes labels, stage directions, markdown and emoji as tokens
// stream in, and sets `stopped` when the model starts another speaker's line so
// the caller can cut generation short (which also saves time).

const LABEL_WORDS = ["opening statement", "closing statement", "opening", "closing", "rebuttal", "response"];

// Text that looks like an action rather than speech: "laughs", "clears throat",
// "slowly shakes head", "dramatic pause".
const ACTION_RE =
  /^(?:\w+ly\s+)?(?:laugh|chuckle|smile|sigh|pause|lean|nod|shrug|gesture|scoff|grin|smirk|frown|wink|whisper|shout|clear|raise|point|tap|shake|stand|sit|turn|look|glance|cross|slam|spread|lower|applause|dramatic|beat|silence)/i;

// Characters held at the start of each line until we know it isn't "Name:".
const HOLD = 48;
// A *span* or (span) longer than this was never a stage direction.
const MAX_SPAN = 120;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function createSpeechFilter({ names = [] } = {}) {
  const nameAlts = names
    .map((n) => (n || "").trim())
    .filter(Boolean)
    .flatMap((n) => [n, n.replace(/^the\s+/i, "")])
    .filter(Boolean)
    .map(escapeRe);
  const speaker = nameAlts.length ? `(?:the\\s+)?(?:${nameAlts.join("|")})` : null;
  const label = [speaker, ...LABEL_WORDS.map(escapeRe)].filter(Boolean).join("|");
  const wrap = `\\s*(?:\\*\\*|__)?\\s*`;
  // Strip "Name:" / "**Name**:" / "Opening statement:" from the start of a line.
  const labelRe = new RegExp(`^\\s*["“]?${wrap}(?:${label})${wrap}[:：]\\s*`, "i");
  // A *later* line starting with a speaker's name means a new speaker's turn.
  const speakerLineRe = speaker ? new RegExp(`^${wrap}${speaker}${wrap}[:：]`, "i") : null;

  let out = ""; // cleaned text for the current push() call
  let tail = ""; // last few characters emitted across ALL calls
  let lineStart = true;
  let lineIndex = 0;
  let held = "";
  let star = false; // saw a lone '*' — could be the start of '**'
  let span = null; // open stage-direction candidate: { close, text, atBoundary }
  let stopped = false;

  const atSentenceBoundary = () => {
    const t = tail.trimEnd();
    return t === "" || /[.!?…:;]["'”’)]*$/.test(t);
  };

  function emitPlain(ch) {
    if (ch === "#" || ch === "`" || ch === "_" || ch === "~" || ch === "\r") return;
    // Double quotes are never spoken, and small models wrap whole paragraphs in
    // them, leaving stray quote marks all over the transcript. (Apostrophes stay.)
    if (ch === '"' || ch === "“" || ch === "”") return;
    if (/\p{Extended_Pictographic}|️|‍/u.test(ch)) return;
    if (ch === " " && (tail === "" || tail.endsWith(" "))) return; // collapse spaces
    out += ch;
    tail = (tail + ch).slice(-8);
  }

  function closeSpan() {
    const s = span;
    span = null;
    const text = s.text.trim();
    // Drop it when it reads like an action, or (for *asterisks*) when it sits
    // between sentences; otherwise it was emphasis or an aside — keep the words.
    const isDirection = ACTION_RE.test(text) || (s.close === "*" && s.atBoundary) || s.close === "]";
    if (isDirection) return;
    if (s.close === ")") emitPlain("(");
    for (const c of s.text) emitPlain(c);
    if (s.close === ")") emitPlain(")");
  }

  function emit(ch) {
    if (star) {
      star = false;
      if (ch === "*") return; // '**' bold marker — drop it, keep the words
      // A lone '*' opens or closes a *span*.
      if (span?.close === "*") closeSpan();
      else if (!span) span = { close: "*", text: "", atBoundary: atSentenceBoundary() };
    }
    if (ch === "*") {
      star = true;
      return;
    }
    if (span) {
      if (ch === span.close) return closeSpan();
      span.text += ch;
      if (span.text.length > MAX_SPAN) {
        // Never closed — it was a stray symbol, not a direction. Give the text back.
        const s = span;
        span = null;
        if (s.close === ")") emitPlain("(");
        for (const c of s.text) emitPlain(c);
      }
      return;
    }
    if (ch === "[") return void (span = { close: "]", text: "", atBoundary: true });
    if (ch === "(") return void (span = { close: ")", text: "", atBoundary: false });
    emitPlain(ch);
  }

  function releaseHeld() {
    let text = held;
    held = "";
    lineStart = false;
    if (lineIndex > 0 && speakerLineRe?.test(text)) {
      stopped = true;
      return;
    }
    text = text.replace(labelRe, "");
    // Models often wrap their whole reply in quotes; drop the opening one.
    if (lineIndex === 0) text = text.replace(/^\s*["“”]\s*/, "");
    for (const c of text) emit(c);
  }

  function newline() {
    lineStart = true;
    lineIndex++;
    emit(" ");
  }

  function feed(text) {
    for (const ch of text) {
      if (stopped) return;
      if (lineStart) {
        if (ch === "\n") {
          if (held) {
            releaseHeld();
            if (!stopped) newline();
          }
          continue;
        }
        held += ch;
        if (held.length >= HOLD || /[.!?…:：]/.test(ch)) releaseHeld();
        continue;
      }
      if (ch === "\n") newline();
      else emit(ch);
    }
  }

  return {
    // Feed a raw delta; returns the cleaned text to speak/show (may be "").
    push(delta) {
      out = "";
      feed(delta);
      return out;
    },
    // End of stream: release anything still held back.
    flush() {
      out = "";
      if (held && !stopped) releaseHeld();
      star = false;
      if (span) {
        const s = span;
        span = null;
        if (s.close !== "]") for (const c of s.text) emitPlain(c);
      }
      return out;
    },
    get stopped() {
      return stopped;
    },
  };
}

// When a turn hits the token cap, drop its unfinished last sentence so speech
// and transcript end cleanly. Keeps the text as-is if it has no full sentence.
export function dropIncompleteTail(text) {
  const m = text.match(/^[\s\S]*[.!?…]["'”’)]*/);
  return m && m[0].trim().length > 0 ? m[0] : text;
}
