import { api } from "../api/client";

/** Fetches a challenge and solves it off the main thread. Returns the proof for the API. */
export async function proveWork(
  purpose: "register" | "restore",
): Promise<{ token: string; nonce: number }> {
  const challenge = await api.powChallenge(purpose);
  const worker = new Worker(new URL("./pow.worker.ts", import.meta.url), { type: "module" });
  try {
    const nonce = await new Promise<number>((resolve, reject) => {
      worker.onmessage = (e: MessageEvent<{ nonce?: number; error?: string }>) => {
        if (typeof e.data.nonce === "number") resolve(e.data.nonce);
        else reject(new Error(e.data.error ?? "proof of work failed"));
      };
      worker.onerror = () => reject(new Error("proof of work failed"));
      worker.postMessage({ challenge: challenge.challenge, difficulty: challenge.difficulty });
    });
    return { token: challenge.token, nonce };
  } finally {
    worker.terminate();
  }
}
