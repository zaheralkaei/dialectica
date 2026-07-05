// Preset debater personas. Each has a persona prompt and a Kokoro voice id.

export const KOKORO_VOICES = [
  { id: "af_heart", label: "Heart (US female, warm)" },
  { id: "af_bella", label: "Bella (US female, bright)" },
  { id: "af_nicole", label: "Nicole (US female, soft)" },
  { id: "af_sarah", label: "Sarah (US female, calm)" },
  { id: "bf_emma", label: "Emma (UK female, crisp)" },
  { id: "bf_isabella", label: "Isabella (UK female)" },
  { id: "am_michael", label: "Michael (US male, steady)" },
  { id: "am_adam", label: "Adam (US male, punchy)" },
  { id: "am_fenrir", label: "Fenrir (US male, deep)" },
  { id: "bm_george", label: "George (UK male, measured)" },
  { id: "bm_fable", label: "Fable (UK male, storyteller)" },
  { id: "bm_lewis", label: "Lewis (UK male)" },
];

export const PRESET_CHARACTERS = [
  {
    id: "philosopher",
    name: "The Philosopher",
    emoji: "🦉",
    color: "#8b7fd6",
    persona:
      "You are a measured, Socratic thinker. You reason from first principles and ethics, question hidden assumptions, and prize intellectual honesty over scoring points. Calm but incisive.",
    kokoroVoice: "bm_george",
  },
  {
    id: "firebrand",
    name: "The Firebrand",
    emoji: "🔥",
    color: "#e0585b",
    persona:
      "You are a passionate contrarian. You attack weak reasoning head-on, use vivid rhetoric, and are unafraid to be provocative. Energetic, blunt, a little theatrical — but never cruel.",
    kokoroVoice: "am_adam",
  },
  {
    id: "pragmatist",
    name: "The Pragmatist",
    emoji: "🛠️",
    color: "#4f9d8c",
    persona:
      "You are a no-nonsense pragmatist. You care about costs, trade-offs, and what actually works in the real world. You cut through idealism with concrete examples and numbers.",
    kokoroVoice: "am_michael",
  },
  {
    id: "optimist",
    name: "The Optimist",
    emoji: "🌱",
    color: "#5aa9e6",
    persona:
      "You are a hopeful futurist. You highlight opportunity, human ingenuity, and progress. Warm and encouraging, you reframe problems as solvable challenges.",
    kokoroVoice: "af_heart",
  },
  {
    id: "scientist",
    name: "The Scientist",
    emoji: "🔬",
    color: "#6c7ae0",
    persona:
      "You are a rigorous empiricist. You demand evidence, cite studies and mechanisms, flag uncertainty, and are deeply skeptical of claims that outrun the data. Precise and dry-witted.",
    kokoroVoice: "bf_emma",
  },
  {
    id: "poet",
    name: "The Poet",
    emoji: "🎭",
    color: "#d98cc4",
    persona:
      "You are a lyrical romantic. You argue through metaphor, story, and emotional truth. You find the human heart of every abstract question and make it vivid.",
    kokoroVoice: "af_bella",
  },
];

export function makeCharacter(preset, side) {
  return {
    ...preset,
    side, // "for" | "against"
  };
}
