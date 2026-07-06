# 🗣️ Dialectica

**Two AI minds debate any topic — with streaming voices, entirely in your browser.**
No backend, no API keys, no server costs. Deploys as a static site to Netlify.

## How it works

- **LLM**: [WebLLM](https://webllm.mlc.ai/) runs a small instruction model (default **Llama 3.2 3B**) on **WebGPU**, fully on-device. One engine is reused for both debaters — turns are sequential, so a second model load would just waste VRAM. The system prompt is swapped each turn to switch personas.
- **TTS (streaming)**: two interchangeable backends
  - **Web Speech API** — built into the browser, zero download, instant. **Default.** Streaming LLM tokens are chunked into sentences so speech starts almost immediately. System voices vary by OS/browser; the persona's gender hint auto-matches an appropriate voice.
  - **[Piper (VITS)](https://github.com/rhasspy/piper)** via `@diffusionstudio/vits-web` — neural TTS (~20–60 MB per voice), runs on CPU (multi-threaded onnxruntime via cross-origin isolation), so the GPU stays entirely with WebLLM. Higher-quality voices, opt-in via the **Voice engine** dropdown.
- **Overlap**: while debater A is *speaking*, debater B's next turn is already being *generated*, keeping the back-and-forth snappy.
- Models download once and are cached in the browser (IndexedDB / Cache API) forever after.

## Customize the debaters

Each side has a preset persona (Philosopher, Firebrand, Pragmatist, Optimist, Scientist, Poet) you can pick from — then freely edit the **name**, the **persona text**, and the **voice**. Enter your own topic, roll a random one, or choose a prepared motion. Set how many total turns the debate runs.

## Run locally

```bash
npm install
npm run dev
```

Open the printed URL in **Chrome or Edge** (WebGPU required for the LLM).

## Deploy to Netlify

Push to a Git repo and connect it to Netlify, or:

```bash
npm run build      # outputs to dist/
npx netlify deploy --prod --dir dist
```

`netlify.toml` already sets the build command, publish dir, and SPA redirect.

## Requirements & notes

- **WebGPU** is required for the on-device LLM — latest Chrome/Edge (desktop), or Chrome on Android with the flag. Safari's WebGPU is still maturing.
- First debate downloads the model (a few hundred MB → ~2 GB depending on the model chosen). Subsequent visits are instant.
- Smaller models (Qwen2.5 1.5B, Llama 3.2 1B) load faster but debate less sharply — pick from the **Model** dropdown.
- If Piper download fails, it's almost always a network/CDN hiccup — the Web Speech engine always works as a fallback (and is the default).

## Stack

Vite · React · `@mlc-ai/web-llm` · `@diffusionstudio/vits-web` (Piper) · Web Speech API · Web Audio API
