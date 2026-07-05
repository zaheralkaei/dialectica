import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import "./styles.css";

// NOTE: StrictMode is intentionally omitted. The debate is an imperative async
// pipeline driven by refs and a single shared LLM/TTS engine; StrictMode's
// dev-only double-mount gives the component fresh refs mid-flight and can spawn
// a duplicate run. Omitting it keeps dev behavior identical to production.
createRoot(document.getElementById("root")).render(<App />);
