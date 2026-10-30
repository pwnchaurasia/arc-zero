/** Water colours (index = engine colour id) with a symbol each for colour-blind play. */
export const WATER = [
  { color: 0xef4444, symbol: "●" },
  { color: 0x3b82f6, symbol: "▲" },
  { color: 0x22c55e, symbol: "■" },
  { color: 0xfacc15, symbol: "◆" },
  { color: 0xa855f7, symbol: "★" },
  { color: 0xf97316, symbol: "✚" },
  { color: 0xec4899, symbol: "♥" },
  { color: 0x14b8a6, symbol: "⬟" },
  { color: 0x84cc16, symbol: "☾" },
  { color: 0xf1f5f9, symbol: "✦" },
  { color: 0x6366f1, symbol: "⬢" },
  { color: 0x92400e, symbol: "✖" },
] as const;

export function water(id: number) {
  return WATER[id % WATER.length] ?? WATER[0];
}

/**
 * Block colour by remaining HP. New blocks have 50-150 HP and span green → red;
 * a block damaged below 50 turns lime, then yellow: close to breaking.
 */
const HP_STOPS: [number, number][] = [
  [1, 0xfacc15],
  [25, 0x84cc16],
  [50, 0x22c55e],
  [70, 0x14b8a6],
  [90, 0x0ea5e9],
  [110, 0x8b5cf6],
  [130, 0xf97316],
  [150, 0xef4444],
];

function mix(a: number, b: number, t: number): number {
  const ch = (c: number, s: number) => (c >> s) & 0xff;
  const m = (s: number) => Math.round(ch(a, s) + (ch(b, s) - ch(a, s)) * t) << s;
  return m(16) | m(8) | m(0);
}

/** Lightens (amount > 0, towards white) or darkens (amount < 0, towards black). */
export function shade(color: number, amount: number): number {
  return mix(color, amount >= 0 ? 0xffffff : 0x000000, Math.min(Math.abs(amount), 1));
}

export function hpColor(hp: number): number {
  let prev: [number, number] | null = null;
  for (const stop of HP_STOPS) {
    if (hp <= stop[0]) {
      return prev ? mix(prev[1], stop[1], (hp - prev[0]) / (stop[0] - prev[0])) : stop[1];
    }
    prev = stop;
  }
  return prev ? prev[1] : 0xffffff;
}
