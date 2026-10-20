import { useEffect, useRef } from "react";

// How close to the bottom (px) still counts as "following along".
const STICK_THRESHOLD = 180;

export default function Transcript({ entries }) {
  const endRef = useRef(null);
  // Auto-scroll only while the reader is following along at the bottom. If they
  // scroll up to re-read something, leave them there instead of yanking the page
  // back down on every revealed sentence (very disruptive on phones).
  const stick = useRef(true);
  const ignoreScrollUntil = useRef(0);

  useEffect(() => {
    const onScroll = () => {
      if (performance.now() < ignoreScrollUntil.current) return; // our own smooth scroll
      const gap = document.documentElement.scrollHeight - (window.scrollY + window.innerHeight);
      stick.current = gap < STICK_THRESHOLD;
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (entries.length <= 1) stick.current = true; // a new debate starts at the bottom
    if (!stick.current || !endRef.current) return;
    ignoreScrollUntil.current = performance.now() + 700;
    endRef.current.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [entries]);

  if (entries.length === 0) return null;

  return (
    <div className="transcript">
      {entries.map((e) => (
        <div
          key={e.id}
          className={`bubble ${e.speaker === "A" ? "left" : "right"}`}
          style={{ "--accent": e.color }}
        >
          <div className="bubble-head">
            <span className="bubble-emoji">{e.emoji}</span>
            <span className="bubble-name">{e.speakerName}</span>
          </div>
          <div className="bubble-text">
            {e.text || (
              <span className="dots" aria-label="thinking">
                <i />
                <i />
                <i />
              </span>
            )}
          </div>
        </div>
      ))}
      <div ref={endRef} className="transcript-end" />
    </div>
  );
}
