import { Graphics, type Renderer, type Texture } from "pixi.js";

import { shade } from "../colors";

/** Zombie kinds, as the engine numbers them. */
export const WALKER = 0;
export const RUNNER = 1;
export const BRUTE = 2;
export const BOSS = 3;

const SKIN = [0x9caf88, 0x8fa37a, 0xa3b18a, 0x879a73];
const SHIRTS = [0x6b7f3a, 0x7c4a2d, 0x4a5568, 0x7f1d1d, 0x2f4f6f, 0x5b4636];

/**
 * A cartoon zombie, drawn once and reused as a texture: arms reaching forward,
 * torn shirt, glowing red eyes. Facing the player (down the bridge).
 */
function drawZombie(g: Graphics, kind: number, variant: number): void {
  const skin = SKIN[variant % SKIN.length] ?? 0x9caf88;
  const shirt = SHIRTS[(variant * 7 + kind) % SHIRTS.length] ?? 0x4a5568;
  const big = kind === BRUTE ? 1.35 : kind === BOSS ? 1 : 1;
  const lean = kind === RUNNER ? 4 : 0;
  // Everything is drawn in a 64 x 96 box, feet at the bottom centre (32, 92).
  g.ellipse(32, 92, 20 * big, 6).fill({ color: 0x000000, alpha: 0.35 });
  // Legs.
  g.roundRect(20 - (big - 1) * 8, 62, 10 * big, 30, 4).fill(0x2d3436);
  g.roundRect(34, 62, 10 * big, 30, 4).fill(0x353b48);
  // Torso: a torn shirt.
  const tw = 30 * big;
  const tx = 32 - tw / 2 + lean;
  g.roundRect(tx, 32, tw, 34, 9).fill(shirt);
  g.poly([tx, 62, tx + tw * 0.25, 70, tx + tw * 0.5, 62, tx + tw * 0.75, 71, tx + tw, 62]).fill(shirt);
  g.roundRect(tx + tw * 0.15, 40, tw * 0.25, 8, 3).fill({ color: shade(shirt, -0.35), alpha: 0.8 });
  g.roundRect(tx + tw * 0.55, 50, tw * 0.3, 6, 3).fill({ color: 0x5c1a1a, alpha: 0.55 });
  // Arms reaching forward (foreshortened toward the viewer).
  g.roundRect(tx - 8, 36, 10, 26, 5).fill(skin);
  g.roundRect(tx + tw - 2, 36, 10, 26, 5).fill(skin);
  g.circle(tx - 3, 64, 6).fill(shade(skin, -0.1));
  g.circle(tx + tw + 3, 64, 6).fill(shade(skin, -0.1));
  // Head.
  const hr = kind === BRUTE ? 13 : 12;
  g.circle(32 + lean * 1.5, 22, hr).fill(skin);
  g.circle(28 + lean * 1.5, 16, hr * 0.4).fill({ color: shade(skin, 0.18), alpha: 0.6 });
  // Glowing red eyes and a dark mouth.
  g.circle(27 + lean * 1.5, 21, 3).fill(0xff2d2d);
  g.circle(37 + lean * 1.5, 21, 3).fill(0xff2d2d);
  g.circle(27 + lean * 1.5, 21, 5.5).fill({ color: 0xff3b3b, alpha: 0.25 });
  g.circle(37 + lean * 1.5, 21, 5.5).fill({ color: 0xff3b3b, alpha: 0.25 });
  g.roundRect(28 + lean * 1.5, 27, 9, 4, 2).fill(0x2b0d0d);
}

/** The boss: a hulking brute with plates and spikes, drawn bigger and darker. */
function drawBoss(g: Graphics): void {
  g.ellipse(64, 182, 46, 12).fill({ color: 0x000000, alpha: 0.4 });
  g.roundRect(36, 120, 24, 62, 8).fill(0x1f2427);
  g.roundRect(70, 120, 24, 62, 8).fill(0x262c30);
  g.roundRect(18, 56, 92, 76, 22).fill(0x6d4c41);
  g.roundRect(30, 66, 68, 24, 8).fill(0x8d6e63);
  for (const x of [26, 46, 66, 86]) g.poly([x, 58, x + 8, 38, x + 16, 58]).fill(0xd7ccc8);
  g.roundRect(0, 62, 26, 64, 12).fill(0x7c8f6a);
  g.roundRect(102, 62, 26, 64, 12).fill(0x7c8f6a);
  g.circle(13, 128, 15).fill(0x6b7d59);
  g.circle(115, 128, 15).fill(0x6b7d59);
  g.circle(64, 40, 28).fill(0x7c8f6a);
  g.circle(52, 36, 6).fill(0xff1f1f);
  g.circle(76, 36, 6).fill(0xff1f1f);
  g.circle(52, 36, 12).fill({ color: 0xff3b3b, alpha: 0.3 });
  g.circle(76, 36, 12).fill({ color: 0xff3b3b, alpha: 0.3 });
  g.roundRect(48, 50, 32, 9, 4).fill(0x2b0d0d);
  for (const x of [52, 60, 68]) g.rect(x, 50, 4, 5).fill(0xe7e2d3);
}

const cache = new Map<string, Texture>();

/** Zombie textures: 4 variants per kind, built once per renderer. */
export function zombieTexture(renderer: Renderer, kind: number, variant: number): Texture {
  const key = `z${kind}:${kind === BOSS ? 0 : variant % 4}`;
  let t = cache.get(key);
  if (!t || t.destroyed) {
    const g = new Graphics();
    if (kind === BOSS) drawBoss(g);
    else drawZombie(g, kind, variant % 4);
    t = renderer.generateTexture({ target: g, resolution: 2 });
    g.destroy();
    cache.set(key, t);
  }
  return t;
}

export function clearArtCache(): void {
  for (const t of cache.values()) if (!t.destroyed) t.destroy(true);
  cache.clear();
}

/** The soldier, seen from behind, drawn around (0, 0) = feet; `muzzle` is the flash colour. */
export function drawGunner(g: Graphics, firing: boolean, muzzle = 0xffd166): void {
  g.clear();
  g.ellipse(0, 0, 26, 8).fill({ color: 0x000000, alpha: 0.4 });
  g.roundRect(-14, -30, 11, 30, 4).fill(0x3d4a2a);
  g.roundRect(3, -30, 11, 30, 4).fill(0x46552f);
  g.roundRect(-20, -70, 40, 44, 12).fill(0x55693a);
  g.roundRect(-16, -66, 32, 30, 8).fill(0x4b5e33); // backpack
  g.roundRect(-12, -60, 24, 6, 3).fill(0x2f3a21);
  g.circle(0, -78, 13).fill(0x5b6e3c); // helmet
  g.roundRect(-14, -80, 28, 6, 3).fill(0x46552f);
  // Minigun held forward (up the screen).
  g.roundRect(8, -96, 16, 40, 5).fill(0x2b2f36);
  for (const dx of [10, 14, 18, 22]) g.rect(dx, -112, 2.5, 20).fill(0x50565f);
  g.roundRect(20, -66, 10, 16, 4).fill(0xd8b48c); // hand
  if (firing) {
    g.circle(16, -116, 10).fill({ color: muzzle, alpha: 0.9 });
    g.circle(16, -118, 18).fill({ color: muzzle, alpha: 0.35 });
  }
}

/** A twin-barrel turret, barrels pointing at `angle` (radians, 0 = up the screen). */
export function drawTurret(g: Graphics, angle: number, recoil: number): void {
  g.clear();
  g.ellipse(0, 6, 34, 11).fill({ color: 0x000000, alpha: 0.35 });
  g.roundRect(-30, -18, 60, 26, 10).fill(0x4d6b2f);
  g.roundRect(-24, -26, 48, 14, 6).fill(0x5f8238);
  const s = Math.sin(angle);
  const c = Math.cos(angle);
  const len = 46 - recoil * 8;
  for (const off of [-7, 7]) {
    const bx = off * c;
    const by = off * s;
    g.moveTo(bx, -24 + by).lineTo(bx + s * len, -24 + by - c * len).stroke({ width: 7, color: 0x3a3f45, cap: "round" });
  }
  g.circle(0, -24, 13).fill(0x6c9440);
  g.circle(-4, -28, 4).fill({ color: 0xffffff, alpha: 0.25 });
}

/** The tank, turret toward `angle`. */
export function drawTank(g: Graphics, angle: number, recoil: number): void {
  g.clear();
  g.ellipse(0, 10, 70, 18).fill({ color: 0x000000, alpha: 0.4 });
  g.roundRect(-66, -24, 132, 40, 12).fill(0x2f3a24);
  for (let x = -58; x <= 58; x += 16) g.circle(x, 8, 7).fill(0x1e2418);
  g.roundRect(-58, -42, 116, 30, 10).fill(0x5b7a32);
  g.roundRect(-50, -38, 100, 8, 4).fill({ color: 0xffffff, alpha: 0.12 });
  const s = Math.sin(angle);
  const c = Math.cos(angle);
  const len = 76 - recoil * 14;
  g.moveTo(0, -52).lineTo(s * len, -52 - c * len).stroke({ width: 11, color: 0x3f5226, cap: "round" });
  g.roundRect(-30, -66, 60, 30, 12).fill(0x6a8c3a);
  g.star(0, -52, 5, 7, 3).fill(0xf5f0d0);
}

/** A gold cage with bars, what's inside named on a plate. */
export function drawCage(g: Graphics, size: number): void {
  g.clear();
  const w = size;
  const h = size * 1.15;
  g.ellipse(0, h * 0.5, w * 0.55, w * 0.14).fill({ color: 0x000000, alpha: 0.35 });
  g.roundRect(-w / 2, -h / 2, w, h, w * 0.08).fill({ color: 0x3b2f12, alpha: 0.55 });
  g.roundRect(-w / 2, -h / 2, w, h * 0.12, 4).fill(0xf6c945);
  g.roundRect(-w / 2, h * 0.38, w, h * 0.12, 4).fill(0xd9a520);
  for (let i = 0; i <= 4; i++) {
    const x = -w / 2 + (w * i) / 4;
    g.rect(x - w * 0.03, -h / 2, w * 0.06, h).fill(i % 2 ? 0xe8b62e : 0xf6c945);
  }
  g.roundRect(-w / 2, -h / 2, w, h, w * 0.08).stroke({ width: Math.max(2, w * 0.04), color: 0xffe08a, alpha: 0.9 });
}

/** A power crate: a sturdy box glowing in the assist's colour. */
export function drawCrate(g: Graphics, size: number, color: number): void {
  g.clear();
  g.circle(0, 0, size * 0.9).fill({ color, alpha: 0.18 });
  g.roundRect(-size / 2, -size / 2, size, size, size * 0.14).fill(0x8a5a2b);
  g.roundRect(-size / 2, -size / 2, size, size, size * 0.14).stroke({ width: Math.max(2, size * 0.08), color: 0x5e3b19 });
  g.moveTo(-size / 2, -size / 2).lineTo(size / 2, size / 2).stroke({ width: Math.max(1.5, size * 0.06), color: 0x5e3b19 });
  g.circle(0, 0, size * 0.28).fill(color);
}

/** The combat mech: two legs, a cockpit and twin cannons, seen from behind. */
export function drawMech(g: Graphics, firing: boolean): void {
  g.clear();
  g.ellipse(0, 0, 40, 11).fill({ color: 0x000000, alpha: 0.4 });
  for (const s of [-1, 1]) {
    g.roundRect(s * 22 - 8, -46, 16, 46, 5).fill(0x3f4a5a);
    g.roundRect(s * 22 - 11, -6, 22, 8, 3).fill(0x2a313c);
  }
  g.roundRect(-34, -92, 68, 50, 14).fill(0x64748b);
  g.roundRect(-26, -86, 52, 12, 5).fill({ color: 0xffffff, alpha: 0.12 });
  g.roundRect(-14, -104, 28, 18, 6).fill(0x475569);
  g.roundRect(-8, -100, 16, 6, 3).fill(0x38bdf8);
  for (const s of [-1, 1]) {
    g.roundRect(s * 40 - 7, -112, 14, 44, 5).fill(0x334155);
    g.rect(s * 40 - 3, -128, 6, 18).fill(0x1e293b);
    if (firing) g.circle(s * 40, -132, 8).fill({ color: 0x7dd3fc, alpha: 0.85 });
  }
}
