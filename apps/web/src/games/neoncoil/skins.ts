/**
 * NeonCoil skins and saved progress. Everything stays on this device: the game is
 * played for fun (decision 2026-11-18), so stars per level and the chosen skin live
 * in local storage. Skins unlock with the total number of stars.
 */
import { LEVEL_COUNT } from "./levels";

export interface Skin {
  id: string;
  name: string;
  /** Colour at the head, fading to `tail` along the body. */
  head: number;
  tail: number;
  /** The glow around the body. */
  glow: number;
  /** Total stars needed to unlock it. */
  unlock: number;
}

export const SKINS: Skin[] = [
  { id: "viper", name: "Cyber Viper", head: 0x4ade80, tail: 0x0ea5e9, glow: 0x22c55e, unlock: 0 },
  { id: "cobalt", name: "Cobalt Pulse", head: 0x60a5fa, tail: 0x6366f1, glow: 0x3b82f6, unlock: 10 },
  { id: "solar", name: "Solar Wyrm", head: 0xfde047, tail: 0xf97316, glow: 0xf59e0b, unlock: 25 },
  { id: "crimson", name: "Crimson Cobra", head: 0xfb7185, tail: 0xdc2626, glow: 0xf43f5e, unlock: 45 },
  { id: "void", name: "Void Phantom", head: 0xe9d5ff, tail: 0x7c3aed, glow: 0xa855f7, unlock: 65 },
  { id: "aurora", name: "Aurora Dragon", head: 0x5eead4, tail: 0xec4899, glow: 0x2dd4bf, unlock: 85 },
];

const FIRST: Skin = SKINS[0] ?? { id: "viper", name: "Cyber Viper", head: 0x4ade80, tail: 0x0ea5e9, glow: 0x22c55e, unlock: 0 };

export const unlocked = (skin: Skin, stars: number) => stars >= skin.unlock;

/** Skins that going from `before` to `after` total stars has just unlocked. */
export const newlyUnlocked = (before: number, after: number) =>
  SKINS.filter((s) => s.unlock > before && s.unlock <= after);

const KEY = "arc.neoncoil.v2";

export interface Saved {
  /** Best stars per level (1-3), by level number. */
  stars: Record<number, number>;
  skin: string;
}

export const totalStars = (saved: Saved) => Object.values(saved.stars).reduce((a, b) => a + b, 0);

/** The highest level that can be played: one past the last cleared. */
export function openLevel(saved: Saved): number {
  let n = 1;
  while (n < LEVEL_COUNT && (saved.stars[n] ?? 0) > 0) n += 1;
  return n;
}

export function loadSaved(): Saved {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Saved>;
    const stars: Record<number, number> = {};
    for (const [k, v] of Object.entries(raw.stars ?? {})) {
      const level = Number(k);
      if (Number.isInteger(level) && level >= 1 && level <= LEVEL_COUNT && [1, 2, 3].includes(v)) stars[level] = v;
    }
    const total = Object.values(stars).reduce((a, b) => a + b, 0);
    const skin = SKINS.find((s) => s.id === raw.skin && unlocked(s, total)) ?? FIRST;
    return { stars, skin: skin.id };
  } catch {
    return { stars: {}, skin: FIRST.id };
  }
}

function write(saved: Saved): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(saved));
  } catch {
    // storage blocked: progress just isn't remembered
  }
}

/** Records a clear, keeping the best stars. Returns the new saved state. */
export function recordClear(level: number, stars: number): Saved {
  const saved = loadSaved();
  saved.stars[level] = Math.max(saved.stars[level] ?? 0, stars);
  write(saved);
  return saved;
}

export function chooseSkin(id: string): Saved {
  const saved = loadSaved();
  if (SKINS.some((s) => s.id === id && unlocked(s, totalStars(saved)))) saved.skin = id;
  write(saved);
  return saved;
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
