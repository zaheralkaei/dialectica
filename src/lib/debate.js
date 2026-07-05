// Builds the system + user prompt for a single debate turn.
//
// Context is deliberately bounded to the last HISTORY_WINDOW turns (the
// opponent's latest turn plus the speaker's own previous one). This keeps every
// prompt small and roughly constant in size no matter how long the debate runs,
// so generation stays fast and memory stays flat — which is what lets a debate
// run indefinitely without slowing to a crawl. A model only needs the opponent's
// last point to rebut it; older history mostly bloats the prompt and slows
// prefill.
const HISTORY_WINDOW = 2; // last N turns fed back as context

export function buildTurnPrompt({
  character,
  opponent,
  topic,
  transcript,
  isOpening,
  wordLimit = 60,
}) {
  const stance =
    character.side === "for"
      ? `Your position: FOR the topic — argue it is true.`
      : `Your position: AGAINST the topic — argue it is false.`;

  const system = [
    character.persona,
    ``,
    `You are ${character.name}, in a live spoken debate against ${opponent.name}.`,
    `Your words go straight to a text-to-speech voice — speak them out loud. This is talk, not an essay.`,
    ``,
    `Topic: "${topic}"`,
    stance,
    ``,
    `How to argue:`,
    `- Stay fully in character and speak in the first person.`,
    `- First knock down ${opponent.name}'s most recent point in a line or two, then drive home ONE sharp argument of your own.`,
    `- Be concrete — reach for a vivid example, a number, or a sharp analogy, never vague generalities.`,
    `- Plain spoken sentences only: no stage directions, markdown, lists, headings, emojis, or "As an AI".`,
    `- Under ${wordLimit} words. Open strong, end on a punchy line, and don't repeat yourself or restate the topic.`,
  ].join("\n");

  let user;
  if (isOpening) {
    user = `Give your opening statement. Don't greet anyone — dive straight into your case.`;
  } else {
    const recent = transcript.slice(-HISTORY_WINDOW);
    const history = recent.map((t) => `${t.speakerName}: ${t.text}`).join("\n\n");
    user = `Most recent exchange:\n\n${history}\n\nNow take your next turn — rebut ${opponent.name}, then push your case.`;
  }

  return { system, user };
}
