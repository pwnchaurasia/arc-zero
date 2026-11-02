import { Application, Container, Graphics, Rectangle, Text } from "pixi.js";

import type { MjDir, MjKind, MjLevelData, MjVehicle } from "../../api/types";
import { mjConstants } from "../../engine/wasm";
import { shade } from "../colors";
import { createPixi, lerp, prefersReducedMotion, tween } from "../pixi";

/** Passenger colours (index = engine colour id), each with a symbol for colour-blind play. */
export const MJ_COLORS = [
  { color: 0xef4444, symbol: "●", name: "red" },
  { color: 0x3b82f6, symbol: "▲", name: "blue" },
  { color: 0x22c55e, symbol: "■", name: "green" },
  { color: 0xfacc15, symbol: "◆", name: "yellow" },
  { color: 0xa855f7, symbol: "★", name: "purple" },
  { color: 0xf97316, symbol: "✚", name: "orange" },
  { color: 0xec4899, symbol: "♥", name: "pink" },
  { color: 0x14b8a6, symbol: "⬟", name: "teal" },
] as const;

export function mjColor(id: number) {
  return MJ_COLORS[id % MJ_COLORS.length] ?? MJ_COLORS[0];
}

const ASPHALT = 0x2a2f45;
const ASPHALT_DARK = 0x1d2134;
const ROAD = 0x343a55;
const LINE = 0xe2e8f0;
const PAVING = 0xb9c3dd;
const TRACK = 0x6b7699;
const TACTILE = 0xfacc15;
const GLASS = 0x22364f;
const GLASS_SHINE = 0x9bd8ff;
const TYRE = 0x11131c;
const BARRIER = 0xf59e0b;

const DELTA: Record<MjDir, [number, number]> = { n: [0, -1], e: [1, 0], s: [0, 1], w: [-1, 0] };

/** Body proportions per vehicle (heights in cells), styled after the game's key art. */
const MODEL: Record<MjKind, { body: number; cabin: number; from: number; to: number; width: number }> = {
  microcar: { body: 0.24, cabin: 0.26, from: 0.22, to: 0.86, width: 0.66 },
  hatchback: { body: 0.25, cabin: 0.25, from: 0.18, to: 0.72, width: 0.72 },
  sedan: { body: 0.25, cabin: 0.24, from: 0.28, to: 0.7, width: 0.74 },
  mpv: { body: 0.28, cabin: 0.28, from: 0.12, to: 0.8, width: 0.76 },
  minivan: { body: 0.3, cabin: 0.32, from: 0.06, to: 0.88, width: 0.78 },
  minibus: { body: 0.32, cabin: 0.34, from: 0.05, to: 0.9, width: 0.8 },
  bus: { body: 0.34, cabin: 0.38, from: 0.03, to: 0.94, width: 0.82 },
};

function kindInfo(kind: MjKind) {
  const info = mjConstants().kinds.find((k) => k.kind === kind);
  if (!info) throw new Error(`unknown vehicle kind ${kind}`);
  return info;
}

const length = (kind: MjKind) => kindInfo(kind).length;
const riderCount = (kind: MjKind) => kindInfo(kind).riders;

/** What the board looks like right now; the controller builds it from the engine. */
export interface MjSnapshot {
  onGrid: boolean[];
  /** `[vehicle, riders]` per bay; vehicle -1 for an empty bay. */
  bays: [number, number][];
  /** Known commuters still waiting, front first. */
  waiting: number[];
  /** Commuters not boarded yet, including hidden ones. */
  remaining: number;
}

export interface MetroJamViewOptions {
  onTap: (vehicle: number) => void;
  symbols: boolean;
}

type Pt = [number, number];

/** World units are grid cells: the lot is x 0..w, y 0..h; the road and the bays sit above it. */
const ROAD_W = 0.8;
const BAY_DEPTH = 1.5;
const LANE_Y = -ROAD_W - BAY_DEPTH / 2;

interface Layout {
  cw: number;
  ch: number;
  zh: number;
  ox: number;
  oy: number;
  ringTop: number;
  ringH: number;
  figure: number;
}

interface Ring {
  cx: number;
  cy: number;
  half: number;
  r: number;
  spacing: number;
  capacity: number;
}

interface Walker {
  sprite: Container;
  /** Place in line along the loop (0 = at the gate); fractional while stepping forward. */
  slot: number;
  phase: number;
}

/**
 * The stop (a loop of commuters), the bays, and the jam, seen from a tilted
 * camera like the key art. Purely visual: the controller owns the rules
 * (WASM engine) and tells the view what happened. `sync` cuts any animation short.
 */
export class MetroJamView {
  private readonly ground = new Graphics();
  private readonly platform = new Container();
  private readonly people = new Container();
  private readonly world = new Container();
  private readonly labels = new Container();
  private readonly fx = new Container();
  private layout: Layout = { cw: 0, ch: 0, zh: 0, ox: 0, oy: 0, ringTop: 0, ringH: 0, figure: 0 };
  private ring: Ring = { cx: 0, cy: 0, half: 0, r: 0, spacing: 1, capacity: 0 };
  private cars: (Container | null)[] = [];
  private bayCars = new Map<number, Container>();
  private seatLabels = new Map<number, Text>();
  private walkers: Walker[] = [];
  private waitingLabel: Text | null = null;
  private snap: MjSnapshot;
  private chain: Promise<void> = Promise.resolve();
  private generation = 0;
  private destroyed = false;
  private clock = 0;
  private readonly fast = prefersReducedMotion();

  private constructor(
    private readonly app: Application,
    private readonly level: MjLevelData,
    snap: MjSnapshot,
    private options: MetroJamViewOptions,
  ) {
    this.snap = snap;
    this.world.sortableChildren = true;
    app.stage.addChild(this.ground, this.platform, this.people, this.world, this.labels, this.fx);
    this.build();
    app.renderer.on("resize", this.relayout);
    app.ticker.add(this.idle);
  }

  static async create(host: HTMLElement, level: MjLevelData, snap: MjSnapshot, options: MetroJamViewOptions) {
    return new MetroJamView(await createPixi(host), level, snap, options);
  }

  destroy(): void {
    this.destroyed = true;
    this.app.renderer.off("resize", this.relayout);
    this.app.ticker.remove(this.idle);
    this.app.destroy({ removeView: true }, { children: true });
  }

  setSymbols(on: boolean): void {
    this.options = { ...this.options, symbols: on };
    this.build();
  }

  /** Shows a state without animation (start, undo, restart). */
  sync(snap: MjSnapshot): void {
    this.generation += 1;
    this.chain = Promise.resolve();
    this.snap = snap;
    this.build();
  }

  /**
   * Animates engine events (flat `[kind, a, b]`, see the WASM `takeEvents`), then settles
   * on `after`. Resolves once everything has finished moving.
   */
  play(events: number[], after: MjSnapshot): Promise<void> {
    const gen = this.generation;
    this.chain = this.chain.then(async () => {
      for (let i = 0; i + 2 < events.length; i += 3) {
        if (this.destroyed || gen !== this.generation) return;
        await this.animate(events[i] ?? -1, events[i + 1] ?? 0, events[i + 2] ?? 0, after);
      }
      // Let the last walkers reach their car before the board settles.
      await this.wait(this.fast ? 0 : 180);
      if (this.destroyed || gen !== this.generation) return;
      this.snap = after;
      this.build();
    });
    return this.chain;
  }

  /** A blocked tap: the car lurches towards its exit and whatever is in the way flashes. */
  bump(vehicle: number, blocker: number): void {
    const car = this.cars[vehicle];
    const v = this.level.vehicles[vehicle];
    if (!car || !v) return;
    const [dx, dy] = DELTA[v.dir];
    const x0 = car.x;
    const y0 = car.y;
    const { cw, ch } = this.layout;
    void this.tw(
      320,
      [car],
      (t) => {
        const k = Math.sin(t * Math.PI * 3) * (1 - t) * 0.14;
        car.x = x0 + dx * cw * k;
        car.y = y0 + dy * ch * k;
      },
      (t) => t,
    );
    const other = blocker >= 0 ? this.cars[blocker] : null;
    if (other) {
      void this.tw(480, [other], (t) => {
        other.tint = t < 1 ? shade(0xffffff, -0.5 * Math.sin(t * Math.PI * 2) ** 2) : 0xffffff;
      });
    }
  }

  // ------------------------------------------------------------- geometry

  private sx(x: number): number {
    return this.layout.ox + x * this.layout.cw;
  }

  private sy(y: number, z = 0): number {
    return this.layout.oy + y * this.layout.ch - z * this.layout.zh;
  }

  private readonly relayout = () => {
    if (!this.destroyed) this.build();
  };

  private computeLayout(): void {
    const W = this.app.screen.width;
    const H = this.app.screen.height;
    const { width: w, height: h } = this.level;
    const ringH = Math.max(96, Math.min(170, H * 0.21));
    const ringTop = 6;
    const worldTop = ringTop + ringH + 4;
    // Cells across: the lot plus a road each side. Down: bays, road, lot, road.
    const across = w + 2 * ROAD_W + 0.2;
    const down = h + 2 * ROAD_W + BAY_DEPTH + 0.4;
    // Width usually limits the cell size on phones; spend spare height on a flatter,
    // clearer camera (less tilt) instead of leaving it empty.
    const cw = Math.max(18, Math.min(W / across, (H - worldTop - 8) / (down * 0.7 + 0.45)));
    const ch = Math.max(cw * 0.7, Math.min(cw * 0.95, (H - worldTop - 8 - cw * 0.45) / down));
    this.layout = {
      cw,
      ch,
      zh: cw * 0.45,
      ox: (W - w * cw) / 2,
      oy: worldTop + (ROAD_W + BAY_DEPTH + 0.15) * ch + 0.45 * cw,
      ringTop,
      ringH,
      figure: Math.max(13, Math.min(22, ringH * 0.15)),
    };
  }

  // -------------------------------------------------------------- drawing

  private build(): void {
    this.computeLayout();
    this.drawGround();
    this.drawRing();
    this.drawCars();
    this.drawBays();
  }

  private drawGround(): void {
    const g = this.ground;
    const { width: w, height: h } = this.level;
    const W = this.app.screen.width;
    const { cw, ch } = this.layout;
    const kerb = this.sy(LANE_Y - BAY_DEPTH / 2);
    g.clear();
    // The stop: paving under the loop, a kerb with a yellow safety line.
    g.rect(0, 0, W, kerb).fill(PAVING);
    g.rect(0, kerb - 5, W, 5).fill(0xe5e9f5);
    g.rect(0, kerb - 10, W, 3).fill(TACTILE);
    // Bay lane and the road round the lot, then the lot itself.
    g.rect(0, kerb, W, this.sy(h + ROAD_W) - kerb).fill(ROAD);
    g.roundRect(this.sx(0), this.sy(0), w * cw, h * ch, 6).fill(ASPHALT);
    g.rect(this.sx(0), this.sy(h), w * cw, Math.max(3, ch * 0.12)).fill(ASPHALT_DARK);
    // Parking lines between cells.
    for (let x = 1; x < w; x++) {
      for (let y = 0; y < h; y++) g.rect(this.sx(x) - 1, this.sy(y + 0.2), 2, ch * 0.6);
    }
    g.fill({ color: LINE, alpha: 0.18 });
    // Dashed centre line on the road round the lot.
    const dash = (x0: number, y0: number, x1: number, y1: number) => {
      const n = Math.max(1, Math.round(Math.hypot(x1 - x0, y1 - y0) / 0.6));
      for (let i = 0; i < n; i += 2) {
        const a = i / n;
        const b = Math.min(1, (i + 1) / n);
        g.moveTo(this.sx(lerp(x0, x1, a)), this.sy(lerp(y0, y1, a))).lineTo(
          this.sx(lerp(x0, x1, b)),
          this.sy(lerp(y0, y1, b)),
        );
      }
    };
    const o = ROAD_W / 2;
    dash(-o, -o, w + o, -o);
    dash(-o, -o, -o, h + o);
    dash(w + o, -o, w + o, h + o);
    dash(-o, h + o, w + o, h + o);
    g.stroke({ width: Math.max(1, cw * 0.035), color: LINE, alpha: 0.45 });
    for (const [bx, by] of this.level.barriers) this.drawBarrier(g, bx, by);
  }

  private drawBarrier(g: Graphics, x: number, y: number): void {
    const { cw, zh } = this.layout;
    const x0 = this.sx(x + 0.2);
    const top = this.sy(y + 0.2, 0.4);
    const w = cw * 0.6;
    const front = this.sy(y + 0.8, 0.4);
    g.roundRect(x0, front, w, zh * 0.4, 3).fill(shade(BARRIER, -0.35));
    g.roundRect(x0, top, w, front - top, 3).fill(BARRIER);
    for (let i = 0; i < 3; i++) {
      g.rect(x0 + (w / 3) * i + w / 12, top, w / 6, front - top).fill({ color: 0x111827, alpha: 0.7 });
    }
  }

  /**
   * A cartoon vehicle centred on its local origin, facing `dir`, in the key-art style:
   * rounded body, glass cabin, tyres, lights and a white arrow on the roof.
   */
  private drawVehicle(v: Pick<MjVehicle, "kind" | "color">, dir: MjDir, scale = 1): Container {
    const root = new Container();
    const g = new Graphics();
    root.addChild(g);
    const cw = this.layout.cw * scale;
    const ch = this.layout.ch * scale;
    const zh = this.layout.zh * scale;
    const len = length(v.kind) - 0.14;
    const m = MODEL[v.kind];
    const [dx, dy] = DELTA[dir];
    const horizontal = dx !== 0;
    const sign = dx + dy;
    const base = mjColor(v.color).color;
    // Footprint (in cells) of the part of the vehicle from a0 to a1 along its length (0 back, 1 front).
    const span = (a0: number, a1: number, half: number) => {
      const s0 = (a0 - 0.5) * len * sign;
      const s1 = (a1 - 0.5) * len * sign;
      const lo = Math.min(s0, s1);
      const hi = Math.max(s0, s1);
      return horizontal ? { x0: lo, x1: hi, y0: -half, y1: half } : { x0: -half, x1: half, y0: lo, y1: hi };
    };
    // A rounded box seen from the tilted camera: its top and its front (south) face.
    const box = (
      f: { x0: number; x1: number; y0: number; y1: number },
      z0: number,
      z1: number,
      top: number,
      front: number,
      radius = 0.14,
    ) => {
      const r = Math.min(radius * cw, ((f.x1 - f.x0) * cw) / 2, ((f.y1 - f.y0) * ch) / 2);
      const X = f.x0 * cw;
      const Wd = (f.x1 - f.x0) * cw;
      g.roundRect(X, f.y1 * ch - z1 * zh, Wd, (z1 - z0) * zh + r, r).fill(front);
      g.roundRect(X, f.y0 * ch - z1 * zh, Wd, (f.y1 - f.y0) * ch, r).fill(top);
    };
    const half = m.width / 2;
    // Shadow.
    const all = span(-0.02, 1.02, half + 0.04);
    g.roundRect(all.x0 * cw + cw * 0.05, all.y0 * ch + ch * 0.08, (all.x1 - all.x0) * cw, (all.y1 - all.y0) * ch, cw * 0.2).fill({
      color: 0x000000,
      alpha: 0.32,
    });
    // Tyres peeking out under the body.
    for (const a of [0.16, 0.84]) {
      for (const c of [-half - 0.02, half - 0.12]) {
        const s = (a - 0.5) * len * sign;
        const f = horizontal
          ? { x0: s - 0.13, x1: s + 0.13, y0: c, y1: c + 0.14 }
          : { x0: c, x1: c + 0.14, y0: s - 0.13, y1: s + 0.13 };
        box(f, 0, 0.2, TYRE, 0x05060a, 0.06);
      }
    }
    const bodyZ0 = 0.1;
    const bodyZ1 = bodyZ0 + m.body;
    const body = span(0, 1, half);
    box(body, bodyZ0, bodyZ1, shade(base, 0.08), shade(base, -0.28), 0.2);
    // Lights on the face we can see: headlights white, tail lights red.
    const lightY = body.y1 * ch - (bodyZ0 + m.body * 0.55) * zh;
    const lightR = Math.max(1.4, cw * 0.05);
    if (!horizontal) {
      const col = dir === "s" ? 0xfef3c7 : 0xf87171;
      g.roundRect(body.x0 * cw + cw * 0.08, lightY, cw * 0.14, lightR * 1.4, lightR).fill(col);
      g.roundRect(body.x1 * cw - cw * 0.22, lightY, cw * 0.14, lightR * 1.4, lightR).fill(col);
    } else {
      const frontX = dx > 0 ? body.x1 * cw - cw * 0.12 : body.x0 * cw + cw * 0.02;
      const backX = dx > 0 ? body.x0 * cw + cw * 0.02 : body.x1 * cw - cw * 0.12;
      g.roundRect(frontX, lightY, cw * 0.1, lightR * 1.4, lightR).fill(0xfef3c7);
      g.roundRect(backX, lightY, cw * 0.1, lightR * 1.4, lightR).fill(0xf87171);
    }
    // Glass cabin: windows on the visible side, coloured roof on top.
    const cab = span(m.from, m.to, half - 0.07);
    const cabZ1 = bodyZ1 + m.cabin;
    box(cab, bodyZ1, cabZ1, shade(base, 0.22), GLASS, 0.16);
    // Window pillars on long vehicles seen from the side, and a glint on the glass.
    const fw = (cab.x1 - cab.x0) * cw;
    const panes = horizontal ? Math.max(1, Math.round((cab.x1 - cab.x0) / 0.55)) : 1;
    for (let i = 1; i < panes; i++) {
      g.rect(cab.x0 * cw + (fw / panes) * i - 1, cab.y1 * ch - cabZ1 * zh, 2, m.cabin * zh).fill(shade(base, -0.1));
    }
    g.rect(cab.x0 * cw + 2, cab.y1 * ch - cabZ1 * zh + m.cabin * zh * 0.2, fw - 4, Math.max(1, zh * 0.03)).fill({
      color: GLASS_SHINE,
      alpha: 0.5,
    });
    // Windscreen on the roof edge facing forward.
    const ws = span(Math.max(m.from, m.to - 0.1), m.to, half - 0.1);
    g.roundRect(ws.x0 * cw, ws.y0 * ch - cabZ1 * zh, (ws.x1 - ws.x0) * cw, (ws.y1 - ws.y0) * ch, cw * 0.06).fill({
      color: GLASS,
      alpha: 0.85,
    });
    // Roof arrow: which way the car drives out.
    const roofY = -cabZ1 * zh;
    const s = Math.min(cw, ch) * 0.24;
    const arrow = new Graphics();
    arrow
      .poly([0, -s, s * 0.9, 0, s * 0.35, 0, s * 0.35, s, -s * 0.35, s, -s * 0.35, 0, -s * 0.9, 0])
      .fill({ color: 0xffffff, alpha: 0.95 })
      .stroke({ width: Math.max(1, s * 0.14), color: shade(base, -0.35), alpha: 0.6 });
    arrow.position.set(0, roofY);
    arrow.rotation = { n: 0, e: Math.PI / 2, s: Math.PI, w: -Math.PI / 2 }[dir];
    root.addChild(arrow);
    if (this.options.symbols) {
      const label = new Text({
        text: mjColor(v.color).symbol,
        style: { fill: 0x0b1020, fontSize: Math.max(9, cw * 0.22), fontWeight: "900" },
      });
      label.anchor.set(0.5);
      label.position.set(horizontal ? -cw * 0.4 : 0, roofY + (horizontal ? 0 : ch * 0.35));
      root.addChild(label);
    }
    const top = Math.min(body.y0 * ch - bodyZ1 * zh, cab.y0 * ch - cabZ1 * zh);
    root.hitArea = new Rectangle(body.x0 * cw, top, (body.x1 - body.x0) * cw, body.y1 * ch - top);
    return root;
  }

  /** Footprint centre of a vehicle on the grid. */
  private centre(v: MjVehicle): Pt {
    const [dx, dy] = DELTA[v.dir];
    const back = length(v.kind) - 1;
    return [v.x + 0.5 - (dx * back) / 2, v.y + 0.5 - (dy * back) / 2];
  }

  private drawCars(): void {
    this.world.removeChildren().forEach((c) => c.destroy({ children: true }));
    this.cars = this.level.vehicles.map((v, i) => {
      if (!(this.snap.onGrid[i] ?? false)) return null;
      const car = this.drawVehicle(v, v.dir);
      const [cx, cy] = this.centre(v);
      car.position.set(this.sx(cx), this.sy(cy));
      // Nearer (lower on screen) cars draw over farther ones.
      car.zIndex = cy + (v.dir === "n" || v.dir === "s" ? length(v.kind) / 2 : 0.5);
      car.eventMode = "static";
      car.cursor = "pointer";
      car.on("pointertap", () => this.options.onTap(i));
      this.world.addChild(car);
      return car;
    });
  }

  // ----------------------------------------------------------------- ring

  private computeRing(): void {
    const W = this.app.screen.width;
    const { ringTop, ringH, figure } = this.layout;
    const r = (ringH - figure * 1.7) / 2;
    const half = Math.max(0, W / 2 - 16 - r - figure * 0.6);
    const loop = 4 * half + 2 * Math.PI * r;
    const spacing = figure * 0.82;
    this.ring = {
      cx: W / 2,
      cy: ringTop + ringH / 2 + figure * 0.2,
      half,
      r,
      spacing,
      // Leave the stretch just right of the gate free: that's where people walk in.
      capacity: Math.floor((loop - spacing * 3) / spacing),
    };
  }

  /**
   * The point `d` pixels behind the gate. The line runs from the gate (bottom middle)
   * left, up round the left end, right along the top, down round the right end and
   * back along the bottom towards the gate: a loop.
   */
  private ringPoint(d: number): Pt {
    const { cx, cy, half, r } = this.ring;
    let s = Math.max(0, d);
    if (s <= half) return [cx - s, cy + r];
    s -= half;
    const arc = Math.PI * r;
    if (s <= arc) {
      const a = Math.PI / 2 + s / r;
      return [cx - half + Math.cos(a) * r, cy + Math.sin(a) * r];
    }
    s -= arc;
    if (s <= 2 * half) return [cx - half + s, cy - r];
    s -= 2 * half;
    if (s <= arc) {
      const a = -Math.PI / 2 + s / r;
      return [cx + half + Math.cos(a) * r, cy + Math.sin(a) * r];
    }
    s -= arc;
    return [cx + half - Math.min(s, half), cy + r];
  }

  private drawFigure(color: number | null): Container {
    const f = new Container();
    const g = new Graphics();
    const s = this.layout.figure;
    const fill = color === null ? 0x8a94b4 : mjColor(color).color;
    g.ellipse(0, s * 0.42, s * 0.28, s * 0.09).fill({ color: 0x000000, alpha: 0.28 });
    // Legs, body, head: a rounded little commuter like the key art.
    g.roundRect(-s * 0.16, s * 0.12, s * 0.12, s * 0.3, s * 0.06).fill(shade(fill, -0.25));
    g.roundRect(s * 0.04, s * 0.12, s * 0.12, s * 0.3, s * 0.06).fill(shade(fill, -0.25));
    g.roundRect(-s * 0.22, -s * 0.24, s * 0.44, s * 0.46, s * 0.18).fill(fill);
    g.circle(0, -s * 0.38, s * 0.17).fill(color === null ? 0xa3acc8 : shade(fill, 0.1));
    g.circle(-s * 0.05, -s * 0.43, s * 0.05).fill({ color: 0xffffff, alpha: 0.6 });
    f.addChild(g);
    if (color === null) {
      const q = new Text({ text: "?", style: { fill: 0xffffff, fontSize: s * 0.34, fontWeight: "900" } });
      q.anchor.set(0.5);
      q.position.set(0, -s * 0.02);
      f.addChild(q);
    } else if (this.options.symbols) {
      const t = new Text({ text: mjColor(color).symbol, style: { fill: 0x0b1020, fontSize: s * 0.28, fontWeight: "900" } });
      t.anchor.set(0.5);
      t.position.set(0, -s * 0.02);
      f.addChild(t);
    }
    return f;
  }

  private drawRing(): void {
    this.computeRing();
    this.platform.removeChildren().forEach((c) => c.destroy({ children: true }));
    this.people.removeChildren().forEach((c) => c.destroy({ children: true }));
    this.walkers = [];
    const { cx, cy, half, r } = this.ring;
    const { figure } = this.layout;
    const g = new Graphics();
    // The track: a wide loop with yellow guide lines either side.
    const outer = r + figure * 0.6;
    const inner = Math.max(4, r - figure * 0.6);
    g.roundRect(cx - half - outer, cy - outer, 2 * (half + outer), 2 * outer, outer)
      .fill(TRACK)
      .stroke({ width: 2, color: TACTILE, alpha: 0.85 });
    g.roundRect(cx - half - inner, cy - inner, 2 * (half + inner), 2 * inner, inner)
      .fill(PAVING)
      .stroke({ width: 2, color: TACTILE, alpha: 0.85 });
    // Gate: where the front of the line steps down to the bays.
    const gy = cy + r;
    g.roundRect(cx - figure * 0.8, gy - figure * 0.95, figure * 1.6, figure * 1.6, 6).stroke({ width: 3, color: 0xffffff });
    g.poly([cx - figure * 0.35, gy + figure * 0.75, cx + figure * 0.35, gy + figure * 0.75, cx, gy + figure * 1.15]).fill(0xffffff);
    this.platform.addChild(g);

    const label = new Text({ text: "", style: { fill: 0x1e293b, fontSize: Math.max(12, figure * 0.75), fontWeight: "900" } });
    label.anchor.set(0.5);
    label.position.set(cx, cy - figure * 0.15);
    this.platform.addChild(label);
    this.waitingLabel = label;

    // Visible commuters in colour, then hidden ones as grey silhouettes until the loop is full.
    const visible = this.snap.waiting.slice(0, Math.min(this.level.visible, this.ring.capacity));
    const shown = Math.min(this.snap.remaining, this.ring.capacity);
    for (let i = 0; i < shown; i++) {
      const sprite = this.drawFigure(visible[i] ?? null);
      this.people.addChild(sprite);
      this.walkers.push({ sprite, slot: i, phase: i * 0.7 });
    }
    this.placeWalkers();
    this.updateWaitingLabel();
  }

  private updateWaitingLabel(): void {
    if (this.waitingLabel && !this.waitingLabel.destroyed) this.waitingLabel.text = `${this.snap.remaining} waiting`;
  }

  private placeWalkers(): void {
    for (const w of this.walkers) {
      if (w.sprite.destroyed) continue;
      const [x, y] = this.ringPoint(w.slot * this.ring.spacing);
      const bob = this.fast ? 0 : Math.abs(Math.sin(this.clock * 6 + w.phase)) * 1.6;
      w.sprite.position.set(x, y - bob);
    }
  }

  /** Keeps the loop in place every frame; people shuffle their feet while they wait. */
  private readonly idle = () => {
    if (this.destroyed) return;
    this.clock += this.app.ticker.deltaMS / 1000;
    this.placeWalkers();
  };

  // ----------------------------------------------------------------- bays

  private bayRect(i: number, count = this.snap.bays.length) {
    const left = -ROAD_W + 0.1;
    const total = this.level.width + 2 * ROAD_W - 0.2;
    const bw = total / count;
    const x0 = left + i * bw;
    return { x0, x1: x0 + bw, cx: x0 + bw / 2, cy: LANE_Y, w: bw };
  }

  /** Scale that fits a parked vehicle (side-on, facing east) inside its bay. */
  private bayScale(kind: MjKind, bayW: number): number {
    return Math.min(1, (bayW * 0.9) / (length(kind) + 0.1));
  }

  private drawBays(): void {
    this.labels.removeChildren().forEach((c) => c.destroy({ children: true }));
    for (const car of this.bayCars.values()) if (!car.destroyed) car.destroy({ children: true });
    this.bayCars.clear();
    this.seatLabels.clear();
    const g = new Graphics();
    const { ch, cw } = this.layout;
    this.labels.addChild(g);
    this.snap.bays.forEach((_, i) => {
      const r = this.bayRect(i);
      const top = this.sy(r.cy - BAY_DEPTH / 2 + 0.1);
      const bottom = this.sy(r.cy + BAY_DEPTH / 2 - 0.15);
      g.rect(this.sx(r.x0), top, 2, bottom - top).fill({ color: LINE, alpha: 0.75 });
      g.rect(this.sx(r.x1) - 2, top, 2, bottom - top).fill({ color: LINE, alpha: 0.75 });
      const num = new Text({ text: `${i + 1}`, style: { fill: 0xffffff, fontSize: Math.max(10, cw * 0.28), fontWeight: "800" } });
      num.alpha = 0.35;
      num.anchor.set(0.5);
      num.position.set(this.sx(r.cx), top + ch * 0.25);
      this.labels.addChild(num);
    });
    this.snap.bays.forEach(([vehicle, riders], i) => {
      const v = this.level.vehicles[vehicle];
      if (v) this.placeInBay(i, v, riders);
    });
  }

  private placeInBay(bay: number, v: MjVehicle, riders: number): void {
    const r = this.bayRect(bay);
    const car = this.drawVehicle(v, "e", this.bayScale(v.kind, r.w));
    car.position.set(this.sx(r.cx), this.sy(r.cy));
    car.zIndex = -10;
    this.world.addChild(car);
    this.bayCars.set(bay, car);
    const seats = new Text({
      text: `${riders}/${riderCount(v.kind)}`,
      style: {
        fill: 0xffffff,
        fontSize: Math.max(11, Math.min(15, this.layout.cw * 0.34)),
        fontWeight: "900",
        stroke: { color: 0x0b1020, width: 3 },
      },
    });
    seats.anchor.set(0.5, 0);
    seats.position.set(this.sx(r.cx), this.sy(r.cy + 0.3));
    this.labels.addChild(seats);
    this.seatLabels.set(bay, seats);
  }

  // ------------------------------------------------------------ animation

  private wait(ms: number): Promise<void> {
    return tween(this.app, ms, () => undefined);
  }

  /** A tween that stops touching its targets once they are destroyed (resize, undo). */
  private tw(ms: number, targets: Container[], fn: (t: number) => void, easing?: (t: number) => number) {
    const gen = this.generation;
    return tween(
      this.app,
      this.fast ? 0 : ms,
      (t) => {
        if (!this.destroyed && gen === this.generation && targets.every((o) => !o.destroyed)) fn(t);
      },
      easing,
    );
  }

  private async animate(kind: number, a: number, b: number, after: MjSnapshot): Promise<void> {
    if (kind === 0) await this.animatePark(a, b, after);
    else if (kind === 1) await this.animateLift(a, b, after);
    else if (kind === 2) await this.animateBoard(a, b);
    else if (kind === 3) await this.animateDepart(a);
    else if (kind === 4) {
      this.snap = { ...this.snap, bays: [...this.snap.bays, [-1, 0]] };
      this.drawBays();
    } else if (kind === 5) {
      this.snap = { ...this.snap, waiting: after.waiting };
      this.drawRing();
    }
  }

  /** The way out of the lot: straight out, round the road to the top, along to the bay. */
  private route(v: MjVehicle, bay: number, bays: number): Pt[] {
    const { width: w, height: h } = this.level;
    const [cx, cy] = this.centre(v);
    const o = ROAD_W / 2;
    const pts: Pt[] = [[cx, cy]];
    if (v.dir === "n") pts.push([cx, -o]);
    else if (v.dir === "e") pts.push([w + o, cy], [w + o, -o]);
    else if (v.dir === "w") pts.push([-o, cy], [-o, -o]);
    else {
      const side = cx < w / 2 ? -o : w + o;
      pts.push([cx, h + o], [side, h + o], [side, -o]);
    }
    const target = this.bayRect(bay, bays);
    pts.push([target.cx, -o], [target.cx, target.cy]);
    return pts;
  }

  /** Drives along the route, turning to face each new direction. Returns the sprite now in use. */
  private async drive(car: Container, v: MjVehicle, pts: Pt[]): Promise<Container> {
    const speed = 28; // cells per second: brisk, so play never waits on the cars
    let current = car;
    let facing = v.dir;
    for (let i = 1; i < pts.length; i++) {
      const [x0, y0] = pts[i - 1] ?? [0, 0];
      const [x1, y1] = pts[i] ?? [0, 0];
      const dist = Math.hypot(x1 - x0, y1 - y0);
      if (dist < 0.01) continue;
      const dir: MjDir = Math.abs(x1 - x0) > Math.abs(y1 - y0) ? (x1 > x0 ? "e" : "w") : y1 > y0 ? "s" : "n";
      if (dir !== facing) {
        const next = this.drawVehicle(v, dir);
        next.position.copyFrom(current.position);
        next.zIndex = 500;
        this.world.addChild(next);
        current.destroy({ children: true });
        current = next;
        facing = dir;
      }
      const c = current;
      await this.tw(
        Math.max(45, (dist / speed) * 1000),
        [c],
        (t) => {
          c.x = this.sx(lerp(x0, x1, t));
          c.y = this.sy(lerp(y0, y1, t));
        },
        (t) => t,
      );
      if (current.destroyed) return current;
    }
    return current;
  }

  private settleInBay(vehicle: number, bay: number, moving: Container): void {
    if (!moving.destroyed) moving.destroy({ children: true });
    const bays = [...this.snap.bays];
    while (bays.length <= bay) bays.push([-1, 0]);
    bays[bay] = [vehicle, 0];
    const onGrid = [...this.snap.onGrid];
    onGrid[vehicle] = false;
    this.snap = { ...this.snap, bays, onGrid };
    this.cars[vehicle] = null;
    this.drawBays();
  }

  private async animatePark(vehicle: number, bay: number, after: MjSnapshot): Promise<void> {
    const car = this.cars[vehicle];
    const v = this.level.vehicles[vehicle];
    if (!car || !v) return;
    car.eventMode = "none";
    car.zIndex = 500;
    const moved = await this.drive(car, v, this.route(v, bay, Math.max(after.bays.length, bay + 1)));
    this.settleInBay(vehicle, bay, moved);
  }

  private async animateLift(vehicle: number, bay: number, after: MjSnapshot): Promise<void> {
    const car = this.cars[vehicle];
    const v = this.level.vehicles[vehicle];
    if (!car || !v) return;
    car.eventMode = "none";
    car.zIndex = 900;
    const target = this.bayRect(bay, Math.max(after.bays.length, bay + 1));
    const x0 = car.x;
    const y0 = car.y;
    const tx = this.sx(target.cx);
    const ty = this.sy(target.cy);
    const lift = this.layout.zh * 2.2;
    await this.tw(520, [car], (t) => {
      car.x = lerp(x0, tx, t);
      car.y = lerp(y0, ty, t) - Math.sin(t * Math.PI) * lift;
      car.scale.set(1 + Math.sin(t * Math.PI) * 0.12);
    });
    this.settleInBay(vehicle, bay, car);
  }

  private async animateBoard(bay: number, vehicle: number): Promise<void> {
    const front = this.walkers.shift();
    const bays = [...this.snap.bays];
    const [, riders] = bays[bay] ?? [vehicle, 0];
    bays[bay] = [vehicle, riders + 1];
    this.snap = { ...this.snap, bays, waiting: this.snap.waiting.slice(1), remaining: this.snap.remaining - 1 };
    this.updateWaitingLabel();
    // A new commuter walks in at the back of the loop if any are left.
    const back = this.walkers.length;
    if (this.snap.remaining > back && back < this.ring.capacity) {
      const sprite = this.drawFigure(null);
      this.people.addChild(sprite);
      this.walkers.push({ sprite, slot: back + 1, phase: back * 0.7 });
    }
    // Whoever just came into view shows their colour.
    const reveal = Math.min(this.level.visible, this.ring.capacity) - 1;
    const known = this.snap.waiting[reveal];
    const target = this.walkers[reveal];
    if (target && known !== undefined) {
      const coloured = this.drawFigure(known);
      this.people.addChild(coloured);
      target.sprite.destroy({ children: true });
      target.sprite = coloured;
    }
    // The whole loop steps forward one place: quick, so long queues fly past.
    const start = this.walkers.map((w) => w.slot);
    const step = Math.max(30, 70 - this.snap.remaining * 0.5);
    const stepping = this.tw(step, [], (t) => this.walkers.forEach((w, i) => (w.slot = lerp(start[i] ?? i + 1, i, t))), (t) => t);
    if (front) {
      const s = front.sprite;
      const r = this.bayRect(bay);
      const fx = s.x;
      const fy = s.y;
      const tx = this.sx(r.cx);
      const ty = this.sy(r.cy);
      void this.tw(170, [s], (t) => {
        s.x = lerp(fx, tx, t);
        s.y = lerp(fy, ty, t) - Math.sin(t * Math.PI) * 18;
        s.scale.set(1 - t * 0.45);
        s.alpha = 1 - t * 0.6;
      }).then(() => {
        if (!s.destroyed) s.destroy({ children: true });
        const label = this.seatLabels.get(bay);
        const v = this.level.vehicles[vehicle];
        const now = this.snap.bays[bay];
        if (label && !label.destroyed && v && now?.[0] === vehicle) label.text = `${now[1]}/${riderCount(v.kind)}`;
        const car = this.bayCars.get(bay);
        if (car && !car.destroyed) {
          const k = car.scale.x;
          void this.tw(120, [car], (t) => car.scale.set(k, k * (1 - Math.sin(t * Math.PI) * 0.05)));
        }
      });
    }
    await stepping;
  }

  private async animateDepart(bay: number): Promise<void> {
    // The last rider reaches the car before it pulls away.
    await this.wait(this.fast ? 0 : 170);
    const car = this.bayCars.get(bay);
    const label = this.seatLabels.get(bay);
    if (label && !label.destroyed) label.text = "Full!";
    if (car && !car.destroyed) {
      this.bayCars.delete(bay);
      const x0 = car.x;
      car.zIndex = 800;
      this.puff(x0, car.y);
      const W = this.app.screen.width;
      await this.tw(360, [car], (t) => (car.x = lerp(x0, W + this.layout.cw * 4, t)), (t) => t * t);
      if (!car.destroyed) car.destroy({ children: true });
    }
    const bays = [...this.snap.bays];
    bays[bay] = [-1, 0];
    this.snap = { ...this.snap, bays };
    this.drawBays();
  }

  /** Confetti when a full vehicle leaves. */
  private puff(x: number, y: number): void {
    if (this.fast) return;
    for (let i = 0; i < 12; i++) {
      const p = new Graphics();
      p.roundRect(-2, -1, 4, 2 + (i % 3), 1).fill(mjColor(i).color);
      p.position.set(x, y);
      this.fx.addChild(p);
      const ang = (i / 12) * Math.PI * 2;
      const dist = 26 + (i % 4) * 8;
      void tween(this.app, 600, (t) => {
        p.x = x + Math.cos(ang) * dist * t;
        p.y = y + Math.sin(ang) * dist * t - 20 * t + 40 * t * t;
        p.rotation = t * 6;
        p.alpha = 1 - t;
      }).then(() => p.destroy());
    }
  }
}
