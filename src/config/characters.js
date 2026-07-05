// Preset debater personas. Each has a persona prompt and a Piper voice id.

// Piper (VITS) voices, from the diffusionstudio/piper-voices set. Each is a
// separate ~20–60 MB download fetched + cached (OPFS) on first use.
export const VOICES = [
  { id: "en_US-hfc_female-medium", label: "Heather (US female, warm)" },
  { id: "en_US-amy-medium", label: "Amy (US female, bright)" },
  { id: "en_US-lessac-medium", label: "Lessac (US female, clear)" },
  { id: "en_US-kristin-medium", label: "Kristin (US female, soft)" },
  { id: "en_GB-jenny_dioco-medium", label: "Jenny (UK female, crisp)" },
  { id: "en_GB-alba-medium", label: "Alba (UK female)" },
  { id: "en_US-hfc_male-medium", label: "Harrison (US male, steady)" },
  { id: "en_US-ryan-high", label: "Ryan (US male, punchy)" },
  { id: "en_US-joe-medium", label: "Joe (US male, deep)" },
  { id: "en_GB-alan-medium", label: "Alan (UK male, measured)" },
  { id: "en_GB-northern_english_male-medium", label: "Cedric (UK male, storyteller)" },
  { id: "en_US-libritts_r-medium", label: "Miles (US male, expressive)" },
];

export const PRESET_CHARACTERS = [
  {
    id: "philosopher",
    name: "The Philosopher",
    emoji: "🦉",
    color: "#8b7fd6",
    persona:
      "You are a measured, Socratic thinker. You reason from first principles and ethics, question hidden assumptions, and prize intellectual honesty over scoring points. Calm but incisive.",
    voice: "en_GB-alan-medium",
  },
  {
    id: "firebrand",
    name: "The Firebrand",
    emoji: "🔥",
    color: "#e0585b",
    persona:
      "You are a passionate contrarian. You attack weak reasoning head-on, use vivid rhetoric, and are unafraid to be provocative. Energetic, blunt, a little theatrical — but never cruel.",
    voice: "en_US-ryan-high",
  },
  {
    id: "pragmatist",
    name: "The Pragmatist",
    emoji: "🛠️",
    color: "#4f9d8c",
    persona:
      "You are a no-nonsense pragmatist. You care about costs, trade-offs, and what actually works in the real world. You cut through idealism with concrete examples and numbers.",
    voice: "en_US-hfc_male-medium",
  },
  {
    id: "optimist",
    name: "The Optimist",
    emoji: "🌱",
    color: "#5aa9e6",
    persona:
      "You are a hopeful futurist. You highlight opportunity, human ingenuity, and progress. Warm and encouraging, you reframe problems as solvable challenges.",
    voice: "en_US-hfc_female-medium",
  },
  {
    id: "scientist",
    name: "The Scientist",
    emoji: "🔬",
    color: "#6c7ae0",
    persona:
      "You are a rigorous empiricist. You demand evidence, cite studies and mechanisms, flag uncertainty, and are deeply skeptical of claims that outrun the data. Precise and dry-witted.",
    voice: "en_GB-jenny_dioco-medium",
  },
  {
    id: "poet",
    name: "The Poet",
    emoji: "🎭",
    color: "#d98cc4",
    persona:
      "You are a lyrical romantic. You argue through metaphor, story, and emotional truth. You find the human heart of every abstract question and make it vivid.",
    voice: "en_US-amy-medium",
  },
];

export function makeCharacter(preset, side) {
  return {
    ...preset,
    side, // "for" | "against"
  };
}
