import { useEffect, useRef } from "react";

export default function Transcript({ entries, activeSpeaker }) {
  const endRef = useRef(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [entries]);

  if (entries.length === 0) return null;

  return (
    <div className="transcript">
      {entries.map((e) => (
        <div
          key={e.id}
          className={`bubble ${e.speaker === "A" ? "left" : "right"} ${
            activeSpeaker === e.speaker && e.text === "" ? "thinking" : ""
          }`}
          style={{ "--accent": e.color }}
        >
          <div className="bubble-head">
            <span className="bubble-emoji">{e.emoji}</span>
            <span className="bubble-name">{e.speakerName}</span>
          </div>
          <div className="bubble-text">
            {e.text || <span className="dots"><i /><i /><i /></span>}
          </div>
        </div>
      ))}
      <div ref={endRef} />
    </div>
  );
}
