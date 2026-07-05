// Prepared debate topics. Phrased as statements so one side argues FOR and the
// other AGAINST.

export const PRESET_TOPICS = [
  "Artificial general intelligence will be net positive for humanity.",
  "Social media has done more harm than good to society.",
  "Humanity should prioritize colonizing Mars within this century.",
  "Remote work is better for both companies and employees.",
  "Universal basic income should replace traditional welfare.",
  "Pineapple belongs on pizza.",
  "Nuclear energy is essential to solving climate change.",
  "Standardized testing should be abolished in schools.",
  "Video games are a legitimate art form on par with film.",
  "It is better to be feared than loved as a leader.",
  "Privacy is more important than security.",
  "Time travel to the past, if possible, should never be attempted.",
];

export function randomTopic() {
  return PRESET_TOPICS[Math.floor(Math.random() * PRESET_TOPICS.length)];
}
