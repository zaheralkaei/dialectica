// Runs the WebLLM engine off the main thread. Generating on the main thread
// starves time-critical work — most importantly the continuations that queue
// the next audio segment — which shows up as gaps between segments and turns.
// In a worker, token generation never blocks the UI or audio scheduling.
import { WebWorkerMLCEngineHandler } from "@mlc-ai/web-llm";

const handler = new WebWorkerMLCEngineHandler();
self.onmessage = (msg) => handler.onmessage(msg);
