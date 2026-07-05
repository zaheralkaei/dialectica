// Builds the system + user prompt for a single debate turn.

const HISTORY_WINDOW = 6; // last N turns fed back as context

export function buildTurnPrompt({
  character,
  opponent,
  topic,
  transcript,
  isOpening,
  wordLimit = 70,
}) {
  const stance =
    character.side === "for"
      ? `You argue IN FAVOR of the motion.`
      : `You argue AGAINST the motion.`;

  const system = [
    character.persona,
    ``,
    `You are "${character.name}", in a live, spoken debate against "${opponent.name}".`,
    `Motion: "${topic}"`,
    stance,
    ``,
    `Rules:`,
    `- Stay fully in character and speak in the first person, out loud. Your words are read aloud by a text-to-speech voice.`,
    `- No stage directions, no markdown, no bullet points, no emojis, no "As an AI".`,
    `- First rebut your opponent's most recent point, then advance one sharp argument of your own.`,
    `- Be vivid and specific. Keep your turn under ${wordLimit} words. End on a strong line.`,
  ].join("\n");

  let user;
  if (isOpening) {
    user = `Deliver your opening statement on the motion. Do not greet the audience — dive straight in.`;
  } else {
    const recent = transcript.slice(-HISTORY_WINDOW);
    const history = recent
      .map((t) => `${t.speakerName}: ${t.text}`)
      .join("\n\n");
    user = `The debate so far:\n\n${history}\n\nNow give ${character.name}'s next turn — rebut, then push your case.`;
  }

  return { system, user };
}
