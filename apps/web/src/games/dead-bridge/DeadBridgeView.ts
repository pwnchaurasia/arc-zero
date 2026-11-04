import { Application, Container, FederatedPointerEvent, Graphics, Rectangle, Sprite, Text } from "pixi.js";

import { haptic, sfx } from "../../feel/audio";
import { createPixi, prefersReducedMotion, tween } from "../pixi";
import {
  BOSS,
  BRUTE,
  clearArtCache,
  drawCage,
  drawCrate,
  drawGunner,
  drawMech,
  drawTank,
  drawTurret,
  zombieTexture,
} from "./art";

/** World geometry from the engine (see the WASM `dbConstants`). */
export interface DbConstants {
  tps: number;
  bridgeW: number;
  lineY: number;
  gunnerY: number;
  lanes: number;
  maxCharges: number;
  maxLogBytes: number;
  /** Full length of each upgrade timer in `hud()` (gun, turrets, tank, mech, barricade). */
  timerTicks: number[];
  crateTicks: number;
  /** How long a unit waits in the ready slot before it deploys on its own. */
  readyTicks: number;
  radius: number[];
}

/** The seven assists, in engine order. */
export const ASSISTS = [
  { key: "airstrike", name: "Airstrike", glyph: "✈", color: 0xf97316 },
  { key: "freeze", name: "Freeze", glyph: "❄", color: 0x38bdf8 },
  { key: "drones", name: "Drones", glyph: "✦", color: 0xa78bfa },
  { key: "lance", name: "Lance", glyph: "⚡", color: 0xfacc15 },
  { key: "napalm", name: "Napalm", glyph: "♨", color: 0xef4444 },
  { key: "barrage", name: "Barrage", glyph: "➶", color: 0xfb7185 },
  { key: "nuke", name: "Nuke", glyph: "☢", color: 0xa3e635 },
] as const;

/** The gunner's weapons, in engine order (the rifle is the default). */
export const GUNS = [
  { name: "Rifle", color: 0xffd166 },
  { name: "Shotgun", color: 0xffb703 },
  { name: "Minigun", color: 0xffe066 },
  { name: "Flamethrower", color: 0xff7a1a },
  { name: "Rockets", color: 0xff4d4d },
  { name: "Laser", color: 0x22d3ee },
] as const;

const REWARD_NAME: Record<number, string> = { 0: "TURRET", 1: "TURRET", 2: "TANK", 3: "MECH", 4: "REPAIR", 5: "BARRICADE" };

/** Cage reward codes: 0-5 units and instants, 10+k assist k, 20+g gun g. */
export function rewardName(code: number): string {
  if (code >= 20) return GUNS[code - 20]?.name.toUpperCase() ?? "?";
  return REWARD_NAME[code] ?? (ASSISTS[code - 10]?.name.toUpperCase() ?? "?");
}

/** Positions in the WASM `hud()` array. */
export const HUD = {
  gunnerX: 0,
  gun: 1,
  hp: 2,
  maxHp: 3,
  wave: 4,
  waves: 5,
  spawned: 6,
  spawns: 7,
  kills: 8,
  frozen: 9,
  drones: 10,
  napalm: 11,
  mechX: 12,
  /** Ticks left: gun, left turret, right turret, tank, mech, barricade. */
  timers: 13,
  /** The ready slot: a cage reward code (-1 empty), and ticks until it deploys itself. */
  ready: 19,
  readyLeft: 20,
} as const;

/** Cage rewards that wait in the ready slot instead of acting at once. */
export const isUnit = (code: number) => code >= 0 && code <= 5 && code !== 4;

const EXPIRED: Record<number, string> = {
  0: "Turret out of ammo",
  2: "Tank out of fuel",
  3: "Mech offline",
  4: "Back to the rifle",
  6: "Barricade down",
};

/** What the view reads each frame (the WASM `DeadBridge`). */
export interface SimView {
  zombies(): Int32Array;
  bullets(): Int32Array;
  cages(): Int32Array;
  crates(): Int32Array;
  hud(): Int32Array;
}

export interface DeadBridgeViewOptions {
  /** Steering: called with an aim lane (0..255) as the pointer moves. */
  onAim: (lane: number) => void;
  /** Called once per simulation tick (30 Hz); the controller steps the sim there. */
  onTick: () => void;
}

interface Layout {
  W: number;
  H: number;
  top: number;
  bottom: number;
  nearW: number;
}

const TURRET_X = [1_100, 8_900];
const TANK_X = 7_400;
const ANNOUNCE_GAP_MS = 700;
/** Touch steering: the gunner moves this many times as far as the finger slides. */
const TOUCH_GAIN = 1.4;

/**
 * The bridge seen from behind the gunner, in perspective (narrow far end, wide near
 * end), like the key art. Purely visual: the controller steps the deterministic sim
 * and hands the view its state and events.
 */
export class DeadBridgeView {
  private readonly backdrop = new Graphics();
  private readonly decals = new Container();
  private readonly world = new Container();
  private readonly bulletsG = new Graphics();
  private readonly bars = new Graphics();
  private readonly fx = new Container();
  private readonly overlay = new Graphics();
  private readonly gunner = new Graphics();
  private readonly turrets = [new Graphics(), new Graphics()];
  private readonly tank = new Graphics();
  private readonly mech = new Graphics();
  private readonly barricade = new Graphics();
  private readonly drones: Graphics[] = [];
  private zombies = new Map<number, { s: Sprite; hp: number; flash: number }>();
  private cages = new Map<
    number,
    { c: Container; g: Graphics; hp: Text; label: Text; last: number; hpLast: number; flash: number }
  >();
  private crates: { c: Container; g: Graphics; glyph: Text }[] = [];
  /** Last seen HP and hit flash per crate, by x (crates never share a column). */
  private crateHits = new Map<number, { hp: number; flash: number }>();
  private layout: Layout = { W: 0, H: 0, top: 0, bottom: 0, nearW: 0 };
  private acc = 0;
  private clock = 0;
  private shake = 0;
  private paused = false;
  private pointerDown = false;
  /** Where a touch slide started: the finger's x and the aimed lane at that moment. */
  private dragFrom: { px: number; lane: number } | null = null;
  /** The lane last aimed at (fractional while sliding). */
  private aimLane: number | null = null;
  private lastAnnounce = 0;
  private hud: Int32Array = new Int32Array(21);
  private destroyed = false;
  private readonly still = prefersReducedMotion();

  private constructor(
    private readonly app: Application,
    private readonly c: DbConstants,
    private readonly sim: SimView,
    private readonly options: DeadBridgeViewOptions,
  ) {
    this.world.sortableChildren = true;
    for (let i = 0; i < 3; i++) {
      const d = new Graphics();
      d.visible = false;
      this.drones.push(d);
    }
    app.stage.addChild(this.backdrop, this.decals, this.world, this.bulletsG, this.bars, this.fx, this.overlay, ...this.drones);
    this.world.addChild(this.gunner, this.tank, this.mech, this.barricade, ...this.turrets);
    app.stage.eventMode = "static";
    app.stage.on("pointerdown", this.onPointer);
    app.stage.on("pointermove", this.onPointer);
    app.stage.on("pointerup", this.onRelease);
    app.stage.on("pointerupoutside", this.onRelease);
    app.renderer.on("resize", this.relayout);
    app.ticker.add(this.frame);
    this.relayout();
  }

  static async create(host: HTMLElement, c: DbConstants, sim: SimView, options: DeadBridgeViewOptions) {
    return new DeadBridgeView(await createPixi(host), c, sim, options);
  }

  destroy(): void {
    this.destroyed = true;
    this.app.ticker.remove(this.frame);
    this.app.renderer.off("resize", this.relayout);
    clearArtCache();
    this.app.destroy({ removeView: true }, { children: true });
  }

  setPaused(on: boolean): void {
    this.paused = on;
    this.acc = 0;
  }

  // ------------------------------------------------------------ geometry

  private depth(y: number): number {
    return Math.min(1, Math.max(0, (y + 1_500) / (this.c.gunnerY + 2_000)));
  }

  private sy(y: number): number {
    const d = this.depth(y);
    const { top, bottom } = this.layout;
    return top + (bottom - top) * (0.36 * d + 0.64 * d * d);
  }

  private scale(y: number): number {
    return 0.4 + 0.6 * this.depth(y);
  }

  private sx(x: number, y: number): number {
    const { W, nearW } = this.layout;
    return W / 2 + (x / this.c.bridgeW - 0.5) * nearW * this.scale(y);
  }

  /** Screen pixels per world unit at depth `y`. */
  private unit(y: number): number {
    return (this.layout.nearW * this.scale(y)) / this.c.bridgeW;
  }

  private readonly relayout = () => {
    if (this.destroyed) return;
    const { width: W, height: H } = this.app.screen;
    // Portrait phones: as wide as the screen. Laptops: wider than tall, but not a strip.
    this.layout = { W, H, top: H * 0.02, bottom: H * 0.995, nearW: Math.min(W * 0.98, H * 1.15) };
    this.app.stage.hitArea = new Rectangle(0, 0, W, H);
    this.drawBackdrop();
  };

  // -------------------------------------------------------------- input

  private readonly onRelease = () => {
    this.pointerDown = false;
    this.dragFrom = null;
  };

  private readonly onPointer = (e: FederatedPointerEvent) => {
    sfx.unlock();
    const lanes = this.c.lanes - 1;
    const margin = 400;
    const toLane = (x: number) => ((x - margin) * lanes) / (this.c.bridgeW - 2 * margin);
    if (e.pointerType === "mouse") {
      // Mice steer just by moving: the gunner goes where the pointer is.
      const x = this.c.bridgeW / 2 + (e.global.x - this.layout.W / 2) / this.unit(this.c.gunnerY);
      this.aimLane = Math.round(toLane(x));
    } else {
      // Touch steers like a trackpad: slide anywhere and the gunner moves by as much
      // (a little more), so the finger never has to sit on (or hide) the gunner.
      if (e.type === "pointerdown") {
        this.pointerDown = true;
        this.dragFrom = { px: e.global.x, lane: this.aimLane ?? toLane(this.hud[HUD.gunnerX] ?? this.c.bridgeW / 2) };
        return;
      }
      if (!this.pointerDown || !this.dragFrom) return;
      const dx = (e.global.x - this.dragFrom.px) / this.unit(this.c.gunnerY);
      this.aimLane = this.dragFrom.lane + toLane(margin + dx * TOUCH_GAIN);
    }
    this.aimLane = Math.max(0, Math.min(lanes, this.aimLane));
    this.options.onAim(Math.round(this.aimLane));
  };

  // ------------------------------------------------------------ backdrop

  private drawBackdrop(): void {
    const g = this.backdrop;
    const { W, H } = this.layout;
    const c = this.c;
    g.clear();
    g.rect(0, 0, W, H).fill(0x0c1220);
    // Dark water either side, with a few moving-light streaks.
    g.rect(0, this.sy(-1_500), W, H).fill(0x0f2236);
    for (let i = 0; i < 18; i++) {
      const y = this.sy(-1_000 + i * 1_100);
      const w = 14 + i * 2;
      g.rect((i * 97) % W, y, w, 2).fill({ color: 0x5aa0d8, alpha: 0.12 });
      g.rect(W - ((i * 131) % W), y + 6, w, 2).fill({ color: 0x5aa0d8, alpha: 0.1 });
    }
    // Deck: strips from far to near, lighter as they come closer.
    const steps = 24;
    const y0 = -1_500;
    const y1 = c.gunnerY + 1_200;
    for (let i = 0; i < steps; i++) {
      const a = y0 + ((y1 - y0) * i) / steps;
      const b = y0 + ((y1 - y0) * (i + 1)) / steps;
      const shadeF = 0.22 + 0.2 * (i / steps);
      const col = Math.round(0x40 * shadeF * 2.2);
      const color = (col << 16) | (col << 8) | Math.round(col * 1.08);
      g.poly([this.sx(0, a), this.sy(a), this.sx(c.bridgeW, a), this.sy(a), this.sx(c.bridgeW, b), this.sy(b), this.sx(0, b), this.sy(b)]).fill(color);
    }
    // Kerbs and railings with posts.
    for (const x of [0, c.bridgeW]) {
      g.moveTo(this.sx(x, y0), this.sy(y0)).lineTo(this.sx(x, y1), this.sy(y1)).stroke({ width: 6, color: 0x6b7280 });
      for (let y = y0; y < y1; y += 1_200) {
        const px = this.sx(x, y);
        const py = this.sy(y);
        const h = 26 * this.scale(y);
        g.rect(px - 2 * this.scale(y), py - h, 4 * this.scale(y), h).fill(0x9ca3af);
      }
      g.moveTo(this.sx(x, y0), this.sy(y0) - 26 * this.scale(y0))
        .lineTo(this.sx(x, y1), this.sy(y1) - 26 * this.scale(y1))
        .stroke({ width: 3, color: 0xcbd5e1, alpha: 0.7 });
    }
    // Lane markings: a dashed centre line and two dashed lanes.
    for (const x of [c.bridgeW / 3, (c.bridgeW * 2) / 3]) {
      for (let y = y0; y < c.lineY; y += 1_400) {
        g.moveTo(this.sx(x, y), this.sy(y)).lineTo(this.sx(x, y + 700), this.sy(y + 700)).stroke({ width: 3 * this.scale(y), color: 0xe5e7eb, alpha: 0.35 });
      }
    }
    for (const dx of [-90, 90]) {
      const x = c.bridgeW / 2 + dx;
      g.moveTo(this.sx(x, y0), this.sy(y0)).lineTo(this.sx(x, c.lineY), this.sy(c.lineY)).stroke({ width: 2.5, color: 0xfacc15, alpha: 0.55 });
    }
    // Cracks and stains for texture.
    for (let i = 0; i < 26; i++) {
      const x = 800 + ((i * 3_571) % 8_400);
      const y = (i * 2_311) % c.lineY;
      const s = this.scale(y);
      g.ellipse(this.sx(x, y), this.sy(y), 22 * s, 7 * s).fill({ color: 0x000000, alpha: 0.18 });
    }
    // Lamps along the railings, with pools of light on the deck.
    for (let y = 600; y < c.lineY; y += 3_200) {
      for (const x of [0, c.bridgeW]) {
        const s = this.scale(y);
        const px = this.sx(x, y);
        const py = this.sy(y) - 60 * s;
        g.rect(px - 1.5 * s, py, 3 * s, 60 * s).fill(0x4b5563);
        g.circle(px, py, 4 * s).fill(0xfff1c1);
        g.circle(px, py, 16 * s).fill({ color: 0xffd27a, alpha: 0.18 });
        const lx = this.sx(x === 0 ? 900 : c.bridgeW - 900, y + 400);
        g.ellipse(lx, this.sy(y + 400), 60 * s, 16 * s).fill({ color: 0xffd27a, alpha: 0.07 });
      }
    }
    // Where the horde comes from: a burning red haze at the far end, fading into fog.
    const far = this.sy(-1_500);
    for (let i = 0; i < 12; i++) {
      g.rect(0, far + i * 7, W, 7).fill({ color: 0xff4d2e, alpha: 0.16 * (1 - i / 12) });
    }
    for (let i = 0; i < 10; i++) {
      g.rect(0, far + 84 + i * 14, W, 14).fill({ color: 0x9aa7c7, alpha: 0.05 * (1 - i / 10) });
    }

    // The line: sandbags and a red warning stripe.
    const ly = c.lineY;
    for (let x = 300; x < c.bridgeW; x += 600) {
      const s = this.scale(ly);
      g.roundRect(this.sx(x, ly) - 16 * s, this.sy(ly) - 10 * s, 32 * s, 14 * s, 6 * s).fill(0x8b7a55);
    }
    g.moveTo(this.sx(0, ly), this.sy(ly) + 6).lineTo(this.sx(c.bridgeW, ly), this.sy(ly) + 6).stroke({ width: 3, color: 0xef4444, alpha: 0.75 });
  }

  // ------------------------------------------------------------- frame

  private readonly frame = () => {
    if (this.destroyed) return;
    const dt = Math.min(this.app.ticker.deltaMS, 250);
    this.clock += dt / 1000;
    if (!this.paused) {
      const step = 1000 / this.c.tps;
      this.acc += dt;
      let n = 0;
      while (this.acc >= step && n < 5) {
        this.options.onTick();
        this.acc -= step;
        n += 1;
      }
    }
    this.render();
  };

  private render(): void {
    const hud = this.sim.hud();
    this.hud = hud;
    this.renderZombies();
    this.renderBullets();
    this.renderCages();
    this.renderCrates();
    this.renderUnits();
    this.renderEffects();
    // Screen shake decays.
    if (this.shake > 0 && !this.still) {
      this.app.stage.position.set((Math.random() - 0.5) * this.shake, (Math.random() - 0.5) * this.shake);
      this.shake *= 0.86;
      if (this.shake < 0.4) {
        this.shake = 0;
        this.app.stage.position.set(0, 0);
      }
    }
  }

  private renderZombies(): void {
    const z = this.sim.zombies();
    const seen = new Set<number>();
    const frozen = (this.hud[HUD.frozen] ?? 0) === 1;
    this.bars.clear();
    for (let i = 0; i + 5 < z.length; i += 6) {
      const id = z[i] ?? 0;
      const kind = z[i + 1] ?? 0;
      const x = z[i + 2] ?? 0;
      const y = z[i + 3] ?? 0;
      const hp = z[i + 4] ?? 0;
      const max = z[i + 5] ?? 1;
      seen.add(id);
      let e = this.zombies.get(id);
      if (!e) {
        const s = new Sprite(zombieTexture(this.app.renderer, kind, id));
        s.anchor.set(0.5, 0.95);
        this.world.addChild(s);
        e = { s, hp, flash: 0 };
        this.zombies.set(id, e);
      }
      if (hp < e.hp) e.flash = 3;
      e.hp = hp;
      const r = this.c.radius[kind] ?? 300;
      const u = this.unit(y);
      const s = e.s;
      const h = r * 4.4 * u;
      s.height = h;
      s.width = h * (s.texture.width / s.texture.height);
      const bob = frozen || this.still ? 0 : Math.sin(this.clock * (kind === 1 ? 14 : 8) + id) * 2.2 * this.scale(y);
      // The sprite is wider than the body the engine keeps on the bridge: draw it
      // inside the rails, so nobody seems to walk off the edge.
      const half = s.width / 2 / u;
      const drawX = half * 2 < this.c.bridgeW ? Math.min(Math.max(x, half), this.c.bridgeW - half) : x;
      s.position.set(this.sx(drawX, y), this.sy(y) + bob);
      s.rotation = frozen || this.still ? 0 : Math.sin(this.clock * 4 + id * 1.7) * 0.06;
      s.zIndex = y;
      s.tint = e.flash > 0 ? 0xffb4b4 : frozen ? 0x9fd8ff : 0xffffff;
      if (e.flash > 0) e.flash -= 1;
      // Health bars: always for brutes and the boss, otherwise once hurt.
      if (kind === BRUTE || kind === BOSS || hp < max) {
        const bw = Math.max(18, h * 0.55);
        const bx = s.x - bw / 2;
        const by = s.y - h - 6;
        this.bars.roundRect(bx, by, bw, 4 + (kind === BOSS ? 3 : 0), 2).fill({ color: 0x000000, alpha: 0.55 });
        const p = Math.max(0, hp / max);
        this.bars.roundRect(bx, by, bw * p, 4 + (kind === BOSS ? 3 : 0), 2).fill(p > 0.5 ? 0x4ade80 : p > 0.25 ? 0xfacc15 : 0xef4444);
      }
    }
    for (const [id, e] of this.zombies) {
      if (!seen.has(id)) {
        e.s.destroy();
        this.zombies.delete(id);
      }
    }
  }

  private renderBullets(): void {
    const b = this.sim.bullets();
    const g = this.bulletsG;
    g.clear();
    for (let i = 0; i + 3 < b.length; i += 4) {
      const x = b[i] ?? 0;
      const y = b[i + 1] ?? 0;
      const kind = b[i + 2] ?? 0;
      const px = this.sx(x, y);
      const py = this.sy(y);
      const s = this.scale(y);
      if (b[i + 3]) {
        // Past its range: a faint spark that only cages and crates still catch.
        g.circle(px, py, 2 * s).fill({ color: kind === 5 ? 0xff9f43 : 0xffd27a, alpha: 0.35 });
        continue;
      }
      switch (kind) {
        case 2: // tank shell
          g.circle(px, py, 7 * s).fill({ color: 0xff9f43, alpha: 0.35 });
          g.circle(px, py, 3.5 * s).fill(0xfff4d6);
          break;
        case 3: // shotgun pellet
          g.circle(px, py, 2.6 * s).fill(0xffd27a);
          break;
        case 5: {
          // flame: flickering blobs that widen as they travel
          const spread = 1 + Math.max(0, this.c.gunnerY - y) / 9_000;
          const f = spread * (this.still ? 1 : 0.75 + 0.25 * Math.sin(this.clock * 40 + x));
          g.circle(px, py, 9 * s * f).fill({ color: 0xff6b1a, alpha: 0.45 });
          g.circle(px, py, 4.5 * s * f).fill({ color: 0xffd166, alpha: 0.8 });
          break;
        }
        case 6: {
          // rocket: a body and a smoke trail
          const tail = this.sy(y + 1_400);
          const tx = this.sx(x, y + 1_400);
          g.moveTo(px, py).lineTo(tx, tail).stroke({ width: 5 * s, color: 0xcbd5e1, alpha: 0.35, cap: "round" });
          g.circle(px, py, 4.5 * s).fill(0xff4d4d);
          g.circle(px, py + 4 * s, 3 * s).fill(0xffd166);
          break;
        }
        case 7: {
          // mech: heavy blue tracers
          const tail = this.sy(y + 900);
          const tx = this.sx(x, y + 900);
          g.moveTo(px, py).lineTo(tx, tail).stroke({ width: 4 * s, color: 0x7dd3fc, alpha: 0.9, cap: "round" });
          break;
        }
        default: {
          // rifle, minigun, turret
          const tail = this.sy(y + 900);
          const tx = this.sx(x, y + 900);
          g.moveTo(px, py).lineTo(tx, tail).stroke({ width: (kind === 4 ? 2.4 : 3) * s, color: kind === 1 ? 0xffa94d : 0xffe066, alpha: 0.9, cap: "round" });
          g.circle(px, py, 2.4 * s).fill(0xfffbe6);
        }
      }
    }
  }

  private renderCages(): void {
    const c = this.sim.cages();
    const seen = new Set<number>();
    for (let i = 0; i + 5 < c.length; i += 6) {
      const index = c[i] ?? 0;
      const x = c[i + 1] ?? 0;
      const y = c[i + 2] ?? 0;
      const hp = c[i + 3] ?? 0;
      const reward = c[i + 5] ?? 0;
      seen.add(index);
      let e = this.cages.get(index);
      if (!e) {
        const cont = new Container();
        const g = new Graphics();
        const hpText = new Text({ text: "", style: { fill: 0xffe08a, fontSize: 22, fontWeight: "900", stroke: { color: 0x3b2a00, width: 4 } } });
        hpText.anchor.set(0.5, 1);
        const label = new Text({ text: rewardName(reward), style: { fill: 0xffffff, fontSize: 13, fontWeight: "900", stroke: { color: 0x000000, width: 3 } } });
        label.anchor.set(0.5);
        cont.addChild(g, label, hpText);
        this.world.addChild(cont);
        e = { c: cont, g, hp: hpText, label, last: -1, hpLast: hp, flash: 0 };
        this.cages.set(index, e);
      }
      // Every hit shows: a quick pop and a bright flash.
      if (hp < e.hpLast) e.flash = 4;
      e.hpLast = hp;
      const size = 1_100 * this.unit(y);
      if (Math.abs(size - e.last) > 0.5) {
        drawCage(e.g, size);
        e.label.style.fontSize = Math.max(9, size * 0.17);
        e.hp.style.fontSize = Math.max(12, size * 0.3);
        e.hp.position.set(0, -size * 0.62);
        e.last = size;
      }
      e.hp.text = `${Math.max(0, hp)}`;
      e.c.position.set(this.sx(x, y), this.sy(y));
      e.c.zIndex = y;
      e.c.scale.set(1 + (this.still ? 0 : Math.sin(this.clock * 3 + index) * 0.02) + e.flash * 0.025);
      e.c.tint = e.flash > 0 ? 0xfff2b0 : 0xffffff;
      if (e.flash > 0) e.flash -= 1;
    }
    for (const [index, e] of this.cages) {
      if (!seen.has(index)) {
        e.c.destroy({ children: true });
        this.cages.delete(index);
      }
    }
  }

  private renderCrates(): void {
    const c = this.sim.crates();
    const n = c.length / 5;
    while (this.crates.length < n) {
      const cont = new Container();
      const g = new Graphics();
      const glyph = new Text({ text: "", style: { fill: 0xffffff, fontSize: 14, fontWeight: "900" } });
      glyph.anchor.set(0.5);
      cont.addChild(g, glyph);
      this.world.addChild(cont);
      this.crates.push({ c: cont, g, glyph });
    }
    this.crates.forEach((e, i) => {
      if (i >= n) {
        e.c.visible = false;
        return;
      }
      const x = c[i * 5] ?? 0;
      const y = c[i * 5 + 1] ?? 0;
      const hp = c[i * 5 + 2] ?? 0;
      const kind = c[i * 5 + 3] ?? 0;
      const left = c[i * 5 + 4] ?? 0;
      const hit = this.crateHits.get(x) ?? { hp, flash: 0 };
      if (hp < hit.hp) hit.flash = 4;
      hit.hp = hp;
      this.crateHits.set(x, hit);
      const a = ASSISTS[kind] ?? ASSISTS[0];
      const size = 650 * this.unit(y);
      drawCrate(e.g, size, a.color);
      e.glyph.text = a.glyph;
      e.glyph.style.fontSize = Math.max(9, size * 0.45);
      e.c.visible = true;
      e.c.position.set(this.sx(x, y), this.sy(y));
      e.c.zIndex = y;
      e.c.rotation = this.still ? 0 : Math.sin(this.clock * 3 + i) * 0.08;
      e.c.scale.set(1 + hit.flash * 0.04);
      if (hit.flash > 0) hit.flash -= 1;
      // Crates fade out: they blink for their last two seconds.
      const blink = left < 2 * this.c.tps && Math.floor(this.clock * 8) % 2 === 0;
      e.c.alpha = hit.flash > 0 ? 1 : blink ? 0.35 : Math.min(1, 0.45 + left / this.c.crateTicks);
    });
    if (this.crateHits.size > 16) {
      const live = new Set(Array.from({ length: n }, (_, i) => c[i * 5] ?? 0));
      for (const x of this.crateHits.keys()) if (!live.has(x)) this.crateHits.delete(x);
    }
  }

  private renderUnits(): void {
    const hud = this.hud;
    const gx = hud[HUD.gunnerX] ?? this.c.bridgeW / 2;
    const left = (k: number) => hud[HUD.timers + k] ?? 0;
    // Units blink for their last three seconds, so their end is no surprise.
    const fading = (ticks: number) => (ticks < 3 * this.c.tps && Math.floor(this.clock * 6) % 2 === 0 ? 0.4 : 1);
    const gy = this.c.gunnerY;
    const firing = !this.paused && Math.floor(this.clock * 30) % 2 === 0;
    drawGunner(this.gunner, firing, GUNS[hud[HUD.gun] ?? 0]?.color);
    this.gunner.position.set(this.sx(gx, gy), this.sy(gy));
    // The drawings are about 120 px tall; the soldier stands ~1,850 world units tall.
    this.gunner.scale.set((1_850 * this.unit(gy)) / 120);
    this.gunner.zIndex = gy;
    // Turrets and the tank point at the nearest zombie.
    const z = this.sim.zombies();
    let front: [number, number] | null = null;
    for (let i = 0; i + 5 < z.length; i += 6) {
      const y = z[i + 3] ?? 0;
      if (!front || y > front[1]) front = [z[i + 2] ?? 0, y];
    }
    const aim = (x: number, y: number) => {
      if (!front) return 0;
      const dx = this.sx(front[0], front[1]) - this.sx(x, y);
      const dy = this.sy(y) - this.sy(front[1]);
      return Math.atan2(dx, Math.max(1, dy));
    };
    const ty = this.c.lineY + 500;
    TURRET_X.forEach((x, side) => {
      const t = this.turrets[side];
      if (!t) return;
      t.visible = left(1 + side) > 0;
      if (!t.visible) return;
      t.alpha = fading(left(1 + side));
      drawTurret(t, aim(x, ty), firing ? 1 : 0);
      t.position.set(this.sx(x, ty), this.sy(ty));
      t.scale.set((1_500 * this.unit(ty)) / 60);
      t.zIndex = ty;
    });
    this.tank.visible = left(3) > 0;
    if (this.tank.visible) {
      this.tank.alpha = fading(left(3));
      drawTank(this.tank, aim(TANK_X, ty), Math.floor(this.clock * 30) % 36 < 4 ? 1 : 0);
      this.tank.position.set(this.sx(TANK_X, ty + 300), this.sy(ty + 300));
      this.tank.scale.set((2_600 * this.unit(ty)) / 140);
      this.tank.zIndex = ty + 300;
    }
      this.mech.visible = left(4) > 0;
    if (this.mech.visible) {
      const my = gy - 300;
      drawMech(this.mech, firing);
      this.mech.alpha = fading(left(4));
      this.mech.position.set(this.sx(hud[HUD.mechX] ?? gx, my), this.sy(my));
      this.mech.scale.set((2_200 * this.unit(my)) / 130);
      this.mech.zIndex = my;
    }
    // The barricade: a glowing steel wall along the line.
    const bar = this.barricade;
    bar.clear();
    if (left(5) > 0) {
      const ly = this.c.lineY;
      const s = this.scale(ly);
      const pulse = this.still ? 1 : 0.8 + 0.2 * Math.sin(this.clock * 8);
      bar.alpha = fading(left(5));
      bar
        .poly([this.sx(0, ly), this.sy(ly) - 30 * s, this.sx(this.c.bridgeW, ly), this.sy(ly) - 30 * s, this.sx(this.c.bridgeW, ly), this.sy(ly), this.sx(0, ly), this.sy(ly)])
        .fill({ color: 0x60a5fa, alpha: 0.28 * pulse })
        .moveTo(this.sx(0, ly), this.sy(ly) - 30 * s)
        .lineTo(this.sx(this.c.bridgeW, ly), this.sy(ly) - 30 * s)
        .stroke({ width: 3, color: 0xbfdbfe, alpha: 0.9 });
      bar.zIndex = ly + 1;
    }
  }

  private renderEffects(): void {
    const g = this.overlay;
    const { W, H } = this.layout;
    const frozen = (this.hud[HUD.frozen] ?? 0) === 1;
    const drones = (this.hud[HUD.drones] ?? 0) === 1;
    const napalm = (this.hud[HUD.napalm] ?? 0) === 1;
    g.clear();
    if (frozen) g.rect(0, 0, W, H).fill({ color: 0x7dd3fc, alpha: 0.12 });
    if (napalm) {
      const top = this.c.lineY - 6_500;
      for (let i = 0; i < 40; i++) {
        const x = (i * 263) % this.c.bridgeW;
        const y = top + ((i * 977) % 6_000);
        const flick = this.still ? 1 : 0.6 + 0.4 * Math.sin(this.clock * 18 + i);
        const s = this.scale(y);
        g.ellipse(this.sx(x, y), this.sy(y), 26 * s, 12 * s * flick).fill({ color: i % 3 ? 0xff6b1a : 0xffc93c, alpha: 0.55 });
      }
    }
    this.drones.forEach((d, i) => {
      d.visible = drones;
      if (!drones) return;
      const a = this.clock * 2 + (i * Math.PI * 2) / 3;
      d.clear()
        .circle(0, 0, 9)
        .fill(0x1f2937)
        .circle(0, 0, 4)
        .fill(0xa78bfa)
        .moveTo(-14, 0)
        .lineTo(14, 0)
        .stroke({ width: 2, color: 0xcbd5e1 });
      d.position.set(W / 2 + Math.cos(a) * W * 0.3, H * 0.28 + Math.sin(a) * H * 0.06);
    });
  }

  // ------------------------------------------------------------- events

  /** Flat `[kind, a, b, c]` events from the sim (see the WASM `takeEvents`). */
  handleEvents(ev: Int32Array): void {
    let hits = 0;
    for (let i = 0; i + 3 < ev.length; i += 4) {
      const kind = ev[i] ?? -1;
      const a = ev[i + 1] ?? 0;
      const b = ev[i + 2] ?? 0;
      const c = ev[i + 3] ?? 0;
      switch (kind) {
        case 0:
          this.announce(a >= (this.hud[HUD.waves] ?? 3) ? "Final wave!" : `Wave ${a}`, 0xfde68a);
          break;
        case 1:
          this.announce("BOSS INCOMING!", 0xf87171);
          sfx.lose();
          this.shake = 10;
          break;
        case 2:
          hits += 1;
          if (c >= 30 || hits % 4 === 0) this.floatText(a, b, `-${c}`, c >= 60 ? 0xff6b6b : 0xffa94d);
          break;
        case 3:
          this.splat(a, b, c);
          break;
        case 4:
          this.shake = Math.max(this.shake, 8 + c * 2);
          this.flash(0xef4444, 0.28);
          haptic(30);
          sfx.invalid();
          break;
        case 5:
          this.burst(a, b, 0xffd166, 22);
          // Units announce themselves when they reach the ready slot (event 14).
          if (!isUnit(c)) this.announce(c >= 10 && c < 20 ? `+1 ${rewardName(c)}` : `${rewardName(c)}!`, 0xffe08a);
          sfx.complete();
          haptic(20);
          break;
        case 6:
          this.burst(a, b, ASSISTS[c]?.color ?? 0xffffff, 12);
          this.floatText(a, b, `+1 ${ASSISTS[c]?.name ?? ""}`, ASSISTS[c]?.color ?? 0xffffff);
          sfx.pickup();
          break;
        case 7:
          this.announce(`${ASSISTS[a]?.name ?? "Assist"}!`, ASSISTS[a]?.color ?? 0xffffff);
          if (a === 1) this.flash(0x7dd3fc, 0.35);
          sfx.laser();
          haptic(25);
          break;
        case 8:
          if (c >= this.c.bridgeW) this.nuke();
          else this.explosion(a, b, c);
          break;
        case 9:
          this.zap(a, b);
          break;
        case 10:
          this.burst(a, this.c.lineY, 0x93c5fd, 6);
          break;
        case 11:
          this.floatText(a, b, "gone", 0x94a3b8);
          break;
        case 12:
          this.beam(a, b);
          break;
        case 14:
          this.announce(`${rewardName(a)} ready!`, 0x86efac);
          break;
        case 15:
          this.announce(`${rewardName(a)} deployed!`, 0xffe08a);
          sfx.complete();
          haptic(20);
          break;
        case 13:
          if (EXPIRED[a]) this.floatText(this.hud[HUD.gunnerX] ?? this.c.bridgeW / 2, this.c.lineY - 1_500, EXPIRED[a], 0xcbd5e1);
          break;
      }
    }
  }

  private floatText(x: number, y: number, text: string, color: number): void {
    const t = new Text({ text, style: { fill: color, fontSize: Math.max(12, 20 * this.scale(y)), fontWeight: "900", stroke: { color: 0x000000, width: 3 } } });
    t.anchor.set(0.5);
    const px = this.sx(x, y);
    const py = this.sy(y) - 30 * this.scale(y);
    t.position.set(px, py);
    this.fx.addChild(t);
    void tween(this.app, 650, (p) => {
      t.y = py - p * 34;
      t.alpha = 1 - p * p;
    }).then(() => t.destroy());
  }

  private splat(x: number, y: number, kind: number): void {
    const s = this.scale(y) * (kind === BOSS ? 3 : kind === BRUTE ? 1.6 : 1);
    const d = new Graphics().ellipse(0, 0, 20 * s, 7 * s).fill({ color: 0x4d6b2f, alpha: 0.7 });
    d.position.set(this.sx(x, y), this.sy(y));
    this.decals.addChild(d);
    void tween(this.app, 1_600, (p) => (d.alpha = 0.7 * (1 - p))).then(() => d.destroy());
    this.burst(x, y, 0x7c9a4a, kind === BOSS ? 30 : 6);
  }

  private burst(x: number, y: number, color: number, n: number): void {
    if (this.still) return;
    const px = this.sx(x, y);
    const py = this.sy(y) - 20 * this.scale(y);
    for (let i = 0; i < n; i++) {
      const p = new Graphics().circle(0, 0, 2 + (i % 3)).fill(color);
      p.position.set(px, py);
      this.fx.addChild(p);
      const a = (i / n) * Math.PI * 2 + Math.random() * 0.4;
      const d = 20 + Math.random() * 40 * this.scale(y);
      void tween(this.app, 520, (t) => {
        p.x = px + Math.cos(a) * d * t;
        p.y = py + Math.sin(a) * d * t + 30 * t * t;
        p.alpha = 1 - t;
      }).then(() => p.destroy());
    }
  }

  private explosion(x: number, y: number, r: number): void {
    const px = this.sx(x, y);
    const py = this.sy(y);
    const size = r * this.unit(y);
    this.shake = Math.max(this.shake, Math.min(14, size / 10));
    // A streak from the sky for airstrikes and tank shells, then the blast.
    const streak = new Graphics();
    this.fx.addChild(streak);
    void tween(this.app, 120, (t) => {
      streak.clear().moveTo(px, py - 200 * (1 - t)).lineTo(px, py - 200 * (1 - t) - 40).stroke({ width: 4, color: 0xfff1c1, alpha: 0.8 });
    }).then(() => {
      streak.destroy();
      const g = new Graphics();
      this.fx.addChild(g);
      void tween(this.app, 480, (t) => {
        g.clear()
          .circle(px, py, size * (0.3 + 0.9 * t))
          .fill({ color: 0xff7a1a, alpha: 0.55 * (1 - t) })
          .circle(px, py, size * (0.15 + 0.5 * t))
          .fill({ color: 0xfff1a8, alpha: 0.8 * (1 - t) });
      }).then(() => g.destroy());
      this.burst(x, y, 0xffb347, 14);
      sfx.blast(3);
    });
  }

  /** The laser rifle (thin, cyan, quick) or the orbital lance (wide, gold, heavy). */
  private beam(x: number, half: number): void {
    const g = new Graphics();
    this.fx.addChild(g);
    const yTop = -1_500;
    const yBot = this.c.lineY;
    const lance = half >= 500;
    if (!lance) {
      void tween(this.app, 120, (t) => {
        g.clear()
          .poly([this.sx(x - half, yTop), this.sy(yTop), this.sx(x + half, yTop), this.sy(yTop), this.sx(x + half / 3, this.c.gunnerY), this.sy(this.c.gunnerY), this.sx(x - half / 3, this.c.gunnerY), this.sy(this.c.gunnerY)])
          .fill({ color: 0x22d3ee, alpha: 0.5 * (1 - t) });
      }).then(() => g.destroy());
      return;
    }
    this.flash(0xfef08a, 0.25);
    this.shake = 12;
    void tween(this.app, 650, (t) => {
      const a = 1 - t;
      g.clear()
        .poly([this.sx(x - half, yTop), this.sy(yTop), this.sx(x + half, yTop), this.sy(yTop), this.sx(x + half, yBot), this.sy(yBot), this.sx(x - half, yBot), this.sy(yBot)])
        .fill({ color: 0xfacc15, alpha: 0.35 * a })
        .poly([this.sx(x - half / 4, yTop), this.sy(yTop), this.sx(x + half / 4, yTop), this.sy(yTop), this.sx(x + half / 4, yBot), this.sy(yBot), this.sx(x - half / 4, yBot), this.sy(yBot)])
        .fill({ color: 0xffffff, alpha: 0.8 * a });
    }).then(() => g.destroy());
  }

  private nuke(): void {
    this.shake = 20;
    haptic(80);
    sfx.blast(3);
    if (this.still) return;
    const g = new Graphics();
    this.fx.addChild(g);
    const { W, H } = this.layout;
    void tween(this.app, 1_100, (t) => {
      g.clear()
        .rect(0, 0, W, H)
        .fill({ color: 0xfefce8, alpha: 0.9 * (1 - t) * (1 - t) })
        .circle(W / 2, H * 0.45, Math.max(W, H) * (0.1 + t))
        .fill({ color: 0xa3e635, alpha: 0.25 * (1 - t) });
    }).then(() => g.destroy());
  }

  private zap(x: number, y: number): void {
    const d = this.drones[Math.floor(Math.random() * this.drones.length)];
    if (!d) return;
    const g = new Graphics();
    this.fx.addChild(g);
    const tx = this.sx(x, y);
    const ty = this.sy(y) - 20 * this.scale(y);
    void tween(this.app, 160, (t) => {
      g.clear().moveTo(d.x, d.y).lineTo(tx, ty).stroke({ width: 3, color: 0xc4b5fd, alpha: 1 - t });
    }).then(() => g.destroy());
  }

  private flash(color: number, alpha: number): void {
    if (this.still) return;
    const g = new Graphics().rect(0, 0, this.layout.W, this.layout.H).fill(color);
    g.alpha = alpha;
    this.fx.addChild(g);
    void tween(this.app, 300, (t) => (g.alpha = alpha * (1 - t))).then(() => g.destroy());
  }

  /** A big message across the bridge; spaced out so they never pile up. */
  announce(text: string, color: number): void {
    const now = performance.now();
    const delay = Math.max(0, this.lastAnnounce + ANNOUNCE_GAP_MS - now);
    this.lastAnnounce = now + delay;
    window.setTimeout(() => {
      if (this.destroyed) return;
      const t = new Text({
        text,
        style: { fill: color, fontSize: Math.max(22, this.layout.W * 0.075), fontWeight: "900", stroke: { color: 0x1a0d00, width: 6 }, align: "center" },
      });
      t.anchor.set(0.5);
      const y0 = this.layout.H * 0.36;
      t.position.set(this.layout.W / 2, y0);
      this.fx.addChild(t);
      void tween(this.app, 1_200, (p) => {
        const pop = this.still ? 1 : p < 0.12 ? 0.6 + (p / 0.12) * 0.5 : 1.1 - Math.min(0.1, (p - 0.12) * 0.4);
        t.scale.set(pop);
        t.alpha = p < 0.75 ? 1 : 1 - (p - 0.75) / 0.25;
        t.y = y0 - p * 20;
      }).then(() => t.destroy());
    }, delay);
  }
}
