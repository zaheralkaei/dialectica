// Editable debater: pick a preset persona, tweak name + persona text, choose a
// voice. Everything is customizable per the requirement that users can change
// the character of the debaters.

export default function DebaterCard({
  side,
  label,
  character,
  onChange,
  presets,
  voices,
  ttsEngine = "piper",
  webVoices,
  active,
  disabled,
}) {
  const applyPreset = (id) => {
    const preset = presets.find((p) => p.id === id);
    if (!preset) return;
    onChange({
      ...character,
      ...preset,
      side: character.side, // keep the for/against side
    });
  };

  const set = (patch) => onChange({ ...character, ...patch });

  // Voice dropdown options depend on the active TTS engine. For Web Speech we
  // show the browser's system voices (the character.voice field still holds the
  // Piper id, used to derive a gender hint — but the user can override with any
  // system voice by selecting one, which we store as webVoice).
  const voiceOptions = ttsEngine === "webspeech" ? webVoices?.() || [] : voices;
  const voiceValue = ttsEngine === "webspeech" ? character.webVoice || "" : character.voice;

  const onVoiceChange = (e) => {
    if (ttsEngine === "webspeech") {
      set({ webVoice: e.target.value });
    } else {
      set({ voice: e.target.value });
    }
  };

  return (
    <div
      className={`debater ${active ? "speaking" : ""}`}
      style={{ "--accent": character.color }}
    >
      <div className="debater-head">
        <span className="avatar" aria-hidden>
          {character.emoji}
        </span>
        <div className="debater-meta">
          <span className="side-label">
            {side} · {label}
          </span>
          <input
            className="name-input"
            value={character.name}
            disabled={disabled}
            onChange={(e) => set({ name: e.target.value })}
          />
        </div>
        {active && <span className="live-dot" title="Speaking">●</span>}
      </div>

      <label className="field">
        <span>Persona preset</span>
        <select
          disabled={disabled}
          value={presets.find((p) => p.id === character.id)?.id || ""}
          onChange={(e) => applyPreset(e.target.value)}
        >
          {presets.map((p) => (
            <option key={p.id} value={p.id}>
              {p.emoji} {p.name}
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        <span>Character / persona</span>
        <textarea
          rows={4}
          value={character.persona}
          disabled={disabled}
          onChange={(e) => set({ persona: e.target.value })}
        />
      </label>

      <label className="field">
        <span>Voice {ttsEngine === "webspeech" && voiceOptions.length === 0 ? "(system voices loading…)" : ""}</span>
        <select
          disabled={disabled}
          value={voiceValue}
          onChange={onVoiceChange}
        >
          {ttsEngine === "webspeech" && (
            <option value="">Auto (match persona gender)</option>
          )}
          {voiceOptions.map((v) => (
            <option key={v.id} value={v.id}>
              {v.label}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
