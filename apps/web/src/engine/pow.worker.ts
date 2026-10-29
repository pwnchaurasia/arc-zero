/// <reference lib="webworker" />
import init, { powSolve } from "../wasm/pkg/arc_engine";

interface Job {
  challenge: string;
  difficulty: number;
}

const CHUNK = 25_000;
const MAX_NONCE = 2 ** 32;

self.onmessage = async (event: MessageEvent<Job>) => {
  const { challenge, difficulty } = event.data;
  await init();
  for (let start = 0; start < MAX_NONCE; start += CHUNK) {
    const nonce = powSolve(challenge, difficulty, start, CHUNK);
    if (nonce >= 0) {
      self.postMessage({ nonce });
      return;
    }
  }
  self.postMessage({ error: "exhausted" });
};
