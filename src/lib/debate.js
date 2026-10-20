// Builds the system + user prompt for a single debate turn.
//
// Memory is deliberately bounded: only the last HISTORY_WINDOW turns (the
// opponent's latest plus the speaker's own previous one) are fed back, plus the
// persona and these instructions. Every prompt stays small and constant in size
// no matter how long the debate runs, so generation speed and memory stay flat
// — which is what lets a debate run indefinitely.
const HISTORY_WINDOW = 2;

// With only two turns of memory, a long debate has no other way to know which
// arguments it already made, so it tends to circle. Steering each round toward
// a different angle keeps it fresh — for a dozen prompt tokens and zero memory.
const ANGLES = [
  "a concrete real-world example",
  "a cost or trade-off the other side is ignoring",
  "a lesson from history",
  "a vivid what-if scenario",
  "the human impact: who gets helped and who gets hurt",
  "an analogy from everyday life",
  "the long-term, second-order consequences",
  "a flaw or contradiction in your opponent's own logic",
  "what would have to be true for your opponent to be right",
  "a perspective nobody has raised yet",
];

// Both debaters advance through the list at different strides, so they never
// lean on the same angle in the same round.
function angleFor(turnIndex) {
  const round = Math.floor(turnIndex / 2);
  return ANGLES[(round * 3 + (turnIndex % 2) * 5) % ANGLES.length];
}

export function buildTurnPrompt({
  character,
  opponent,
  topic,
  transcript,
  turnIndex,
  isClosing = false,
  wordLimit = 60,
}) {
  const name = character.name?.trim() || "Debater";
  const opp = opponent.name?.trim() || "your opponent";
  const stance =
    character.side === "for"
      ? `Your position: FOR the topic — argue it is true.`
      : `Your position: AGAINST the topic — argue it is false.`;

  const system = [
    character.persona,
    ``,
    `You are ${name}, in a live spoken debate against ${opp}.`,
    `Your words go straight to a text-to-speech voice, so write only what you would say out loud. This is talk, not an essay.`,
    ``,
    `Topic: "${topic}"`,
    stance,
    ``,
    `How to argue:`,
    `- Stay fully in character and speak in the first person.`,
    `- Answer ${opp}'s latest point head-on in a sentence or two, then make ONE sharp new argument of your own.`,
    `- Be concrete: a vivid example, a number, or a sharp analogy beats vague generalities.`,
    `- Plain spoken sentences only: no stage directions, no actions in asterisks or brackets, no markdown, lists, headings, emojis, or "As an AI".`,
    `- Reply with your own words only. Never repeat or quote ${opp}'s words back, never write ${opp}'s lines, and never start with a name label.`,
    `- Under ${wordLimit} words. Open strong, end on a punchy line, and don't repeat yourself or restate the topic.`,
  ].join("\n");

  const recent = transcript.slice(-HISTORY_WINDOW);
  const angle = angleFor(turnIndex);
  let user;
  if (recent.length === 0) {
    user = `Give your opening statement. Don't greet anyone — dive straight into your strongest case, built around ${angle}.`;
  } else if (turnIndex === 1 && recent.length === 1) {
    // Not presented as a quoted block — small models tend to echo a quotation
    // back verbatim.
    user =
      `${opp}'s opening statement:\n${recent[0].text}\n\n` +
      `Now give YOUR opening statement, in your own words: push back on their opening in one sentence, then lay out your own case, built around ${angle}.`;
  } else {
    const history = recent.map((t) => `${t.speakerName}: ${t.text}`).join("\n\n");
    user = isClosing
      ? `Most recent exchange:\n\n${history}\n\nThis is your CLOSING statement: knock down ${opp}'s last point, then sum up why your side wins in one memorable final line.`
      : `Most recent exchange:\n\n${history}\n\nYour turn: rebut ${opp}, then push your case using ${angle}.`;
  }

  // Stop strings end generation the moment the model starts scripting the next
  // speaker (WebLLM honours these natively; the speech filter also catches it).
  const stop = [`\n${opp}:`, `\n${name}:`];

  return { system, user, stop };
}

// Extra instruction for a retry after the model parroted the previous turn.
export const NO_ECHO_RETRY =
  "\n\nImportant: your last attempt just repeated what was already said. Do NOT copy any earlier sentence — argue your own side in completely fresh words.";

// Small models sometimes copy the opponent's turn word for word. Treat it as an
// echo when the first 8 words of the new turn appear verbatim in a recent turn.
const ECHO_WORDS = 8;
const words = (s) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

export function isEcho(text, transcript) {
  const head = words(text).slice(0, ECHO_WORDS);
  if (head.length < ECHO_WORDS) return false;
  const needle = ` ${head.join(" ")} `;
  return transcript.slice(-HISTORY_WINDOW).some((t) => ` ${words(t.text).join(" ")} `.includes(needle));
}
