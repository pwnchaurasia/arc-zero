/**
 * NeonCoil skins and the saved best score. Everything stays on this device: the game
 * is played for fun, so the best score lives in local storage (decision 2026-11-18).
 */

export interface Skin {
  id: string;
  name: string;
  /** Colour at the head, fading to `tail` along the body. */
  head: number;
  tail: number;
  /** The glow around the body. */
  glow: number;
  /** Best score needed to unlock it. */
  unlock: number;
}

export const SKINS: Skin[] = [
  { id: "viper", name: "Cyber Viper", head: 0x4ade80, tail: 0x0ea5e9, glow: 0x22c55e, unlock: 0 },
  { id: "cobalt", name: "Cobalt Pulse", head: 0x60a5fa, tail: 0x6366f1, glow: 0x3b82f6, unlock: 150 },
  { id: "solar", name: "Solar Wyrm", head: 0xfde047, tail: 0xf97316, glow: 0xf59e0b, unlock: 300 },
  { id: "crimson", name: "Crimson Cobra", head: 0xfb7185, tail: 0xdc2626, glow: 0xf43f5e, unlock: 500 },
  { id: "void", name: "Void Phantom", head: 0xe9d5ff, tail: 0x7c3aed, glow: 0xa855f7, unlock: 800 },
  { id: "aurora", name: "Aurora Dragon", head: 0x5eead4, tail: 0xec4899, glow: 0x2dd4bf, unlock: 1200 },
];

const FIRST: Skin = SKINS[0] ?? { id: "viper", name: "Cyber Viper", head: 0x4ade80, tail: 0x0ea5e9, glow: 0x22c55e, unlock: 0 };

export const unlocked = (skin: Skin, best: number) => best >= skin.unlock;

/** Skins that a new best of `after` (up from `before`) has just unlocked. */
export const newlyUnlocked = (before: number, after: number) =>
  SKINS.filter((s) => s.unlock > before && s.unlock <= after);

const KEY = "arc.neoncoil";

interface Saved {
  best: number;
  skin: string;
}

export function loadSaved(): Saved {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Saved>;
    const best = Number.isFinite(raw.best) && (raw.best ?? 0) > 0 ? Math.floor(raw.best ?? 0) : 0;
    const skin = SKINS.find((s) => s.id === raw.skin && unlocked(s, best)) ?? FIRST;
    return { best, skin: skin.id };
  } catch {
    return { best: 0, skin: FIRST.id };
  }
}

export function save(patch: Partial<Saved>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...loadSaved(), ...patch }));
  } catch {
    // storage blocked: the best just isn't remembered
  }
}

export const skinById = (id: string) => SKINS.find((s) => s.id === id) ?? FIRST;

/** Mixes two 0xRRGGBB colours (`t` 0 gives `a`, 1 gives `b`). */
export function mix(a: number, b: number, t: number): number {
  const ch = (shift: number) => {
    const x = (a >> shift) & 0xff;
    const y = (b >> shift) & 0xff;
    return Math.round(x + (y - x) * t) << shift;
  };
  return ch(16) | ch(8) | ch(0);
}
