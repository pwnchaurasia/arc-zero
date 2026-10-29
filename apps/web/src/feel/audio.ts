import { getSettings } from "../state/settings";

/**
 * Tiny synthesiser on the Web Audio API: no audio files, zero latency.
 * The context is created on the first user gesture (browser autoplay rules).
 */
let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let lastHit = 0;

function audio(): { ctx: AudioContext; out: GainNode } | null {
  if (!getSettings().sound) return null;
  if (!ctx) {
    try {
      ctx = new AudioContext({ latencyHint: "interactive" });
      master = ctx.createGain();
      master.gain.value = 0.35;
      master.connect(ctx.destination);
    } catch {
      return null;
    }
  }
  if (ctx.state === "suspended") void ctx.resume();
  return master ? { ctx, out: master } : null;
}

function tone(
  freq: number,
  duration: number,
  type: OscillatorType = "sine",
  volume = 1,
  slideTo?: number,
): void {
  const a = audio();
  if (!a) return;
  const t = a.ctx.currentTime;
  const osc = a.ctx.createOscillator();
  const gain = a.ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t + duration);
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(volume, t + 0.005);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
  osc.connect(gain).connect(a.out);
  osc.start(t);
  osc.stop(t + duration + 0.02);
}

export const sfx = {
  /** Call from any pointer handler so later sounds are allowed to play. */
  unlock(): void {
    audio();
  },
  tap(): void {
    tone(660, 0.05, "triangle", 0.4);
  },
  pour(fill: number): void {
    // Higher pitch as the target fills up, like real liquid.
    tone(220 + fill * 70, 0.18, "sine", 0.5, 320 + fill * 90);
  },
  invalid(): void {
    tone(140, 0.12, "square", 0.25, 110);
  },
  complete(): void {
    tone(880, 0.12, "triangle", 0.4, 1320);
  },
  hit(hp: number): void {
    const now = performance.now();
    if (now - lastHit < 25) return; // hundreds of hits per second would turn into noise
    lastHit = now;
    tone(300 + Math.min(hp, 150) * 4, 0.04, "triangle", 0.18);
  },
  blast(combo: number): void {
    tone(440 * Math.pow(1.06, Math.min(combo, 24)), 0.14, "square", 0.3, 220);
  },
  laser(): void {
    tone(1800, 0.2, "sawtooth", 0.15, 400);
  },
  pickup(): void {
    tone(990, 0.1, "triangle", 0.35, 1480);
  },
  win(): void {
    [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => tone(f, 0.18, "triangle", 0.4), i * 90));
  },
  lose(): void {
    [392, 330, 262].forEach((f, i) => setTimeout(() => tone(f, 0.22, "sine", 0.35), i * 120));
  },
};

export function haptic(ms: number): void {
  if (!getSettings().haptics) return;
  try {
    navigator.vibrate?.(ms);
  } catch {
    // unsupported
  }
}
