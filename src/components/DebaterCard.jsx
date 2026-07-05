// Editable debater: pick a preset persona, tweak name + persona text, choose a
// voice. Everything is customizable per the requirement that users can change
// the character of the debaters.

export default function DebaterCard({
  side,
  label,
  character,
  onChange,
  presets,
  kokoroVoices,
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
        <span>Voice</span>
        <select
          disabled={disabled}
          value={character.kokoroVoice}
          onChange={(e) => set({ kokoroVoice: e.target.value })}
        >
          {kokoroVoices.map((v) => (
            <option key={v.id} value={v.id}>
              {v.label}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
