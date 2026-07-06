// Preset debater personas. Each has a persona prompt and a Piper voice id.
// The `voice` field is engine-agnostic: for Piper it's the voice ID string; for
// Web Speech it carries a { lang, gender } hint that maps to a system voice.

// Piper (VITS) voices, from the diffusionstudio/piper-voices set. Each is a
// separate ~20–60 MB download fetched + cached (OPFS) on first use.
export const VOICES = [
  { id: "en_US-hfc_female-medium", label: "Heather (US female, warm)", hint: { lang: "en-US", gender: "female" } },
  { id: "en_US-amy-medium", label: "Amy (US female, bright)", hint: { lang: "en-US", gender: "female" } },
  { id: "en_US-lessac-medium", label: "Lessac (US female, clear)", hint: { lang: "en-US", gender: "female" } },
  { id: "en_US-kristin-medium", label: "Kristin (US female, soft)", hint: { lang: "en-US", gender: "female" } },
  { id: "en_GB-jenny_dioco-medium", label: "Jenny (UK female, crisp)", hint: { lang: "en-GB", gender: "female" } },
  { id: "en_GB-alba-medium", label: "Alba (UK female)", hint: { lang: "en-GB", gender: "female" } },
  { id: "en_US-hfc_male-medium", label: "Harrison (US male, steady)", hint: { lang: "en-US", gender: "male" } },
  { id: "en_US-ryan-high", label: "Ryan (US male, punchy)", hint: { lang: "en-US", gender: "male" } },
  { id: "en_US-joe-medium", label: "Joe (US male, deep)", hint: { lang: "en-US", gender: "male" } },
  { id: "en_GB-alan-medium", label: "Alan (UK male, measured)", hint: { lang: "en-GB", gender: "male" } },
  { id: "en_GB-northern_english_male-medium", label: "Cedric (UK male, storyteller)", hint: { lang: "en-GB", gender: "male" } },
  { id: "en_US-libritts_r-medium", label: "Miles (US male, expressive)", hint: { lang: "en-US", gender: "male" } },
];

// Resolve the voice field for a given engine. Piper wants the ID string; Web
// Speech wants either a specific system voiceURI (character.webVoice, if the
// user picked one) or the { lang, gender } hint derived from the Piper voice id.
export function voiceForEngine(character, engine) {
  if (engine === "webspeech") {
    if (character.webVoice) return character.webVoice; // user-picked system voice
    const v = VOICES.find((x) => x.id === character.voice);
    return v?.hint || { lang: "en", gender: undefined };
  }
  return character.voice; // piper
}

// Build a sorted list of Web Speech system voices suitable for a <select>.
// Re-reads live each call (no caching) so the UI updates when voices arrive
// async via the voiceschanged event — getVoices() returns [] until then.
export function webSpeechVoiceOptions() {
  if (!("speechSynthesis" in window)) return [];
  const voices = window.speechSynthesis.getVoices();
  if (!voices.length) return [];
  const english = voices
    .filter((v) => v.lang.toLowerCase().startsWith("en"))
    .sort((a, b) => a.name.localeCompare(b.name));
  return (english.length ? english : voices).map((v) => ({
    id: v.voiceURI,
    label: `${v.name} (${v.lang})`,
  }));
}

export const PRESET_CHARACTERS = [
  {
    id: "philosopher",
    name: "The Philosopher",
    emoji: "🦉",
    color: "#8b7fd6",
    persona:
      "You are The Philosopher: a measured, Socratic thinker. You reason from first principles and ethics, and your signature move is to expose the hidden assumption beneath your opponent's argument and turn it against them. Calm, precise, quietly devastating.",
    voice: "en_GB-alan-medium",
  },
  {
    id: "firebrand",
    name: "The Firebrand",
    emoji: "🔥",
    color: "#e0585b",
    persona:
      "You are The Firebrand: a passionate contrarian who attacks weak reasoning head-on. You hit hard with vivid, punchy rhetoric and a memorable line, and you love catching your opponent in a contradiction. Energetic, blunt, a little theatrical — but never cruel.",
    voice: "en_US-ryan-high",
  },
  {
    id: "pragmatist",
    name: "The Pragmatist",
    emoji: "🛠️",
    color: "#4f9d8c",
    persona:
      "You are The Pragmatist: a no-nonsense realist who cares only about costs, trade-offs, and what actually works. You deflate grand theories by asking what they'd cost on Tuesday morning, and you win with concrete examples and hard numbers. Dry, grounded, unimpressed by idealism.",
    voice: "en_US-hfc_male-medium",
  },
  {
    id: "optimist",
    name: "The Optimist",
    emoji: "🌱",
    color: "#5aa9e6",
    persona:
      "You are The Optimist: a hopeful futurist who champions opportunity, human ingenuity, and progress. Your signature move is to reframe your opponent's doom as a solvable challenge and point to how far we've already come. Warm, energizing, relentlessly forward-looking.",
    voice: "en_US-hfc_female-medium",
  },
  {
    id: "scientist",
    name: "The Scientist",
    emoji: "🔬",
    color: "#6c7ae0",
    persona:
      "You are The Scientist: a rigorous empiricist who demands evidence. You cite mechanisms and data, flag uncertainty honestly, and dismantle claims that outrun the evidence. Your signature move is to ask 'what would we actually observe if that were true?'. Precise, skeptical, dry-witted.",
    voice: "en_GB-jenny_dioco-medium",
  },
  {
    id: "poet",
    name: "The Poet",
    emoji: "🎭",
    color: "#d98cc4",
    persona:
      "You are The Poet: a lyrical romantic who argues through metaphor, story, and emotional truth. You answer your opponent's cold logic by finding the human heart of the question and making it ache. Vivid, moving, unafraid of beauty.",
    voice: "en_US-amy-medium",
  },
];

export function makeCharacter(preset, side) {
  return {
    ...preset,
    side, // "for" | "against"
  };
}
