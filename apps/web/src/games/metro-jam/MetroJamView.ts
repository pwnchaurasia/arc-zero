import { Application, Container, Graphics, Polygon, Text } from "pixi.js";

import type { MjDir, MjKind, MjLevelData, MjVehicle } from "../../api/types";
import { mjConstants } from "../../engine/wasm";
import { shade } from "../colors";
import { createPixi, ease, lerp, prefersReducedMotion, tween } from "../pixi";

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

const ASPHALT = 0x1f2433;
const ASPHALT_EDGE = 0x151925;
const LANE = 0x3a4160;
const GLASS = 0x1b2a44;
const GLASS_SHINE = 0x7dd3fc;
const BARRIER = 0xf59e0b;
const PLATFORM = 0x2b3355;
const TACTILE = 0xfacc15;

const DELTA: Record<MjDir, [number, number]> = { n: [0, -1], e: [1, 0], s: [0, 1], w: [-1, 0] };

/** Body proportions per vehicle: heights in tile units (z), and how much is glass. */
const MODEL: Record<MjKind, { body: number; cabin: number; cabinFrom: number; cabinTo: number; width: number }> = {
  microcar: { body: 0.3, cabin: 0.26, cabinFrom: 0.2, cabinTo: 0.9, width: 0.62 },
  hatchback: { body: 0.3, cabin: 0.25, cabinFrom: 0.3, cabinTo: 0.92, width: 0.68 },
  sedan: { body: 0.3, cabin: 0.24, cabinFrom: 0.3, cabinTo: 0.75, width: 0.7 },
  mpv: { body: 0.34, cabin: 0.27, cabinFrom: 0.22, cabinTo: 0.94, width: 0.72 },
  minivan: { body: 0.38, cabin: 0.3, cabinFrom: 0.14, cabinTo: 0.97, width: 0.74 },
  minibus: { body: 0.42, cabin: 0.32, cabinFrom: 0.1, cabinTo: 0.98, width: 0.76 },
  bus: { body: 0.46, cabin: 0.36, cabinFrom: 0.04, cabinTo: 0.99, width: 0.8 },
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

interface Layout {
  tile: number;
  ox: number;
  oy: number;
  queueY: number;
  queueH: number;
  figure: number;
  baysY: number;
  baysH: number;
}

type Pt = [number, number];

function convexHull(points: Pt[]): Pt[] {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const half = (input: Pt[]) => {
    const out: Pt[] = [];
    for (const p of input) {
      for (;;) {
        const a = out.at(-2);
        const b = out.at(-1);
        if (!a || !b || cross(a, b, p) > 0) break;
        out.pop();
      }
      out.push(p);
    }
    return out.slice(0, -1);
  };
  return [...half(pts), ...half([...pts].reverse())];
}

/**
 * Isometric jam, commuter queue and parking bays. Purely visual: the controller
 * owns the rules (WASM engine) and tells the view what happened.
 */
export class MetroJamView {
  private readonly ground = new Graphics();
  private readonly jam = new Container();
  private readonly platform = new Container();
  private readonly bayLayer = new Container();
  private readonly fx = new Container();
  private layout: Layout = { tile: 0, ox: 0, oy: 0, queueY: 0, queueH: 0, figure: 0, baysY: 0, baysH: 0 };
  private cars: Container[] = [];
  private bayCars = new Map<number, Container>();
  private figures: Container[] = [];
  private snap: MjSnapshot;
  private chain: Promise<void> = Promise.resolve();
  private generation = 0;
  private destroyed = false;
  private readonly fast = prefersReducedMotion();

  private constructor(
    private readonly app: Application,
    private readonly level: MjLevelData,
    snap: MjSnapshot,
    private options: MetroJamViewOptions,
  ) {
    this.snap = snap;
    this.jam.sortableChildren = true;
    app.stage.addChild(this.ground, this.platform, this.jam, this.bayLayer, this.fx);
    this.build();
    app.renderer.on("resize", this.relayout);
  }

  static async create(host: HTMLElement, level: MjLevelData, snap: MjSnapshot, options: MetroJamViewOptions) {
    return new MetroJamView(await createPixi(host), level, snap, options);
  }

  destroy(): void {
    this.destroyed = true;
    this.app.renderer.off("resize", this.relayout);
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
   * Animates engine events (flat `[kind, a, b]`, see the WASM `takeEvents`),
   * then settles on `after`.
   */
  play(events: number[], after: MjSnapshot): Promise<void> {
    const gen = this.generation;
    this.chain = this.chain.then(async () => {
      for (let i = 0; i + 2 < events.length; i += 3) {
        if (this.destroyed || gen !== this.generation) return;
        await this.animate(events[i] ?? -1, events[i + 1] ?? 0, events[i + 2] ?? 0, after);
      }
      if (this.destroyed || gen !== this.generation) return;
      this.snap = after;
      this.build();
    });
    return this.chain;
  }

  /** A blocked tap: the car lurches and whatever is in its way flashes. */
  bump(vehicle: number, blocker: number): void {
    const car = this.cars[vehicle];
    const v = this.level.vehicles[vehicle];
    if (!car || !v) return;
    const [dx, dy] = DELTA[v.dir];
    const [sx, sy] = this.vec(dx, dy);
    const x0 = car.x;
    const y0 = car.y;
    void this.tw(
      320,
      [car],
      (t) => {
        const k = Math.sin(t * Math.PI * 3) * (1 - t) * 0.12;
        car.x = x0 + sx * k;
        car.y = y0 + sy * k;
      },
      (t) => t,
    );
    const other = blocker >= 0 ? this.cars[blocker] : undefined;
    if (other) {
      void this.tw(420, [other], (t) => {
        other.tint = t < 1 ? shade(0xffffff, -0.45 * Math.sin(t * Math.PI * 2) ** 2) : 0xffffff;
      });
    }
  }

  // ------------------------------------------------------------- geometry

  /** Grid point (cells, z in tile units) to screen. */
  private iso(x: number, y: number, z = 0): Pt {
    const { tile, ox, oy } = this.layout;
    return [ox + (x - y) * tile * 0.5, oy + (x + y) * tile * 0.25 - z * tile * 0.5];
  }

  /** Screen offset of a grid vector. */
  private vec(dx: number, dy: number): Pt {
    const t = this.layout.tile;
    return [(dx - dy) * t * 0.5, (dx + dy) * t * 0.25];
  }

  private readonly relayout = () => {
    if (!this.destroyed) this.build();
  };

  private computeLayout(): void {
    const W = this.app.screen.width;
    const H = this.app.screen.height;
    const queueH = Math.max(64, Math.min(96, H * 0.13));
    const baysH = Math.max(84, Math.min(118, H * 0.16));
    const span = this.level.width + this.level.height;
    const availH = H - queueH - baysH - 28;
    // +1.6: the kerb around the lot (0.35 cells each side) and a little air.
    const tile = Math.max(16, Math.min((W * 0.96 * 2) / (span + 1.6), ((availH - 12) * 4) / (span + 3)));
    const gridH = span * tile * 0.25;
    const top = queueH + 12 + Math.max(0, (availH - gridH - tile * 0.5) / 2) + tile * 0.5;
    this.layout = {
      tile,
      ox: W / 2 + (this.level.height - this.level.width) * tile * 0.25,
      oy: top,
      queueY: 8,
      queueH,
      figure: Math.min(26, queueH * 0.42),
      baysY: H - baysH - 16,
      baysH,
    };
  }

  // -------------------------------------------------------------- drawing

  private build(): void {
    this.computeLayout();
    this.drawGround();
    this.drawPlatform();
    this.drawCars();
    this.drawBays();
  }

  private drawGround(): void {
    const g = this.ground;
    const { width: w, height: h } = this.level;
    g.clear();
    const edge = 0.35;
    const c0 = this.iso(-edge, -edge);
    const c1 = this.iso(w + edge, -edge);
    const c2 = this.iso(w + edge, h + edge);
    const c3 = this.iso(-edge, h + edge);
    const corners = [c0, c1, c2, c3];
    const depth = this.layout.tile * 0.18;
    // Slab sides, then the road surface.
    g.poly([...c1, ...c2, c2[0], c2[1] + depth, c1[0], c1[1] + depth]).fill(ASPHALT_EDGE);
    g.poly([...c2, ...c3, c3[0], c3[1] + depth, c2[0], c2[1] + depth]).fill(shade(ASPHALT_EDGE, -0.3));
    g.poly(corners.flat()).fill(ASPHALT);
    // Dashed lane lines between cells.
    for (let x = 1; x < w; x++) {
      for (let y = 0; y < h; y++) {
        const a = this.iso(x, y + 0.3);
        const b = this.iso(x, y + 0.7);
        g.moveTo(a[0], a[1]).lineTo(b[0], b[1]);
      }
    }
    for (let y = 1; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const a = this.iso(x + 0.3, y);
        const b = this.iso(x + 0.7, y);
        g.moveTo(a[0], a[1]).lineTo(b[0], b[1]);
      }
    }
    g.stroke({ width: Math.max(1, this.layout.tile * 0.02), color: LANE });
    // Exit arrows around the edge show that cars leave the lot.
    g.poly(corners.flat()).stroke({ width: Math.max(1.5, this.layout.tile * 0.04), color: 0x4b5578, alpha: 0.9 });
    for (const [bx, by] of this.level.barriers) this.drawBarrier(g, bx, by);
  }

  private drawBarrier(g: Graphics, x: number, y: number): void {
    const p = (dx: number, dy: number, z: number) => this.iso(x + dx, y + dy, z);
    const top = 0.45;
    g.poly([...p(0.8, 0.2, 0), ...p(0.8, 0.8, 0), ...p(0.8, 0.8, top), ...p(0.8, 0.2, top)]).fill(shade(BARRIER, -0.25));
    g.poly([...p(0.8, 0.8, 0), ...p(0.2, 0.8, 0), ...p(0.2, 0.8, top), ...p(0.8, 0.8, top)]).fill(shade(BARRIER, -0.45));
    g.poly([...p(0.2, 0.2, top), ...p(0.8, 0.2, top), ...p(0.8, 0.8, top), ...p(0.2, 0.8, top)]).fill(BARRIER);
    const m1 = this.iso(x + 0.3, y + 0.5, 0.45);
    const m2 = this.iso(x + 0.7, y + 0.5, 0.45);
    g.moveTo(m1[0], m1[1]).lineTo(m2[0], m2[1]).stroke({ width: Math.max(2, this.layout.tile * 0.06), color: 0x111827 });
  }

  /** Draws a vehicle centred on its local origin, as if at grid (0,0)-centred footprint. */
  private drawVehicle(v: Pick<MjVehicle, "kind" | "color" | "dir">, scale = 1): Container {
    const root = new Container();
    const g = new Graphics();
    root.addChild(g);
    const t = this.layout.tile * scale;
    const p = (x: number, y: number, z: number): Pt => [(x - y) * t * 0.5, (x + y) * t * 0.25 - z * t * 0.5];
    const len = length(v.kind);
    const m = MODEL[v.kind];
    const [dx, dy] = DELTA[v.dir];
    const along = (a: number, c: number): Pt => {
      // a: 0 (back) .. 1 (front) along the length; c: -0.5..0.5 across.
      const s = (a - 0.5) * (len - 0.16);
      return [dx * s + -dy * c, dy * s + dx * c];
    };
    const box = (a0: number, a1: number, half: number, z0: number, z1: number, color: number, top = color) => {
      const corners = [along(a0, -half), along(a1, -half), along(a1, half), along(a0, half)];
      const xs = corners.map((c) => c[0]);
      const ys = corners.map((c) => c[1]);
      const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
      g.poly([...p(x0, y1, z0), ...p(x1, y1, z0), ...p(x1, y1, z1), ...p(x0, y1, z1)]).fill(shade(color, -0.42));
      g.poly([...p(x1, y0, z0), ...p(x1, y1, z0), ...p(x1, y1, z1), ...p(x1, y0, z1)]).fill(shade(color, -0.22));
      g.poly([...p(x0, y0, z1), ...p(x1, y0, z1), ...p(x1, y1, z1), ...p(x0, y1, z1)]).fill(top);
      return { x0, x1, y0, y1 };
    };
    const base = mjColor(v.color).color;
    const half = m.width / 2;
    // Soft shadow on the road.
    const sh = [along(-0.02, -half - 0.06), along(1.02, -half - 0.06), along(1.02, half + 0.06), along(-0.02, half + 0.06)];
    g.poly(sh.flatMap(([x, y]) => p(x + 0.06, y + 0.06, 0))).fill({ color: 0x000000, alpha: 0.35 });
    // Wheels: dark blocks peeking under the body.
    const wheelZ = 0.09;
    box(0.04, 0.96, half - 0.02, 0, wheelZ, 0x0b0d14);
    const body = box(0, 1, half, wheelZ, wheelZ + m.body, base, shade(base, 0.12));
    // Glass cabin with a coloured roof.
    const cabZ = wheelZ + m.body;
    box(m.cabinFrom, m.cabinTo, half - 0.06, cabZ, cabZ + m.cabin, GLASS, shade(base, 0.28));
    // Window shine and a direction chevron on the roof.
    const roofZ = cabZ + m.cabin;
    const s1 = along(m.cabinFrom + 0.05, half - 0.07);
    const s2 = along(m.cabinTo - 0.05, half - 0.07);
    const a = p(s1[0], s1[1], cabZ + m.cabin * 0.75);
    const b = p(s2[0], s2[1], cabZ + m.cabin * 0.75);
    g.moveTo(a[0], a[1]).lineTo(b[0], b[1]).stroke({ width: Math.max(1, t * 0.025), color: GLASS_SHINE, alpha: 0.55 });
    const tip = along(Math.min(m.cabinTo, 0.98), 0);
    const l = along(Math.min(m.cabinTo, 0.98) - 0.28 / len, -0.17);
    const r = along(Math.min(m.cabinTo, 0.98) - 0.28 / len, 0.17);
    g.poly([...p(tip[0], tip[1], roofZ), ...p(l[0], l[1], roofZ), ...p(r[0], r[1], roofZ)]).fill({ color: 0xffffff, alpha: 0.85 });
    // Headlights, when the front bumper faces the viewer.
    for (const c of v.dir === "e" || v.dir === "s" ? [-half + 0.12, half - 0.12] : []) {
      const hl = along(1, c);
      const [hx, hy] = p(hl[0], hl[1], wheelZ + m.body * 0.55);
      g.circle(hx, hy, Math.max(1.2, t * 0.035)).fill({ color: 0xfef9c3, alpha: 0.95 });
    }
    if (this.options.symbols) {
      const label = new Text({
        text: mjColor(v.color).symbol,
        style: { fill: 0x0b1020, fontSize: Math.max(9, t * 0.26), fontWeight: "900" },
      });
      label.anchor.set(0.5);
      const c = along(0.5, 0);
      const [lx, ly] = p(c[0], c[1], roofZ);
      label.position.set(lx, ly);
      root.addChild(label);
    }
    root.hitArea = new Polygon(
      convexHull([
        p(body.x0, body.y0, roofZ),
        p(body.x1, body.y0, roofZ),
        p(body.x1, body.y1, roofZ),
        p(body.x0, body.y1, roofZ),
        p(body.x1, body.y1, 0),
        p(body.x1, body.y0, 0),
        p(body.x0, body.y1, 0),
      ]).flat(),
    );
    return root;
  }

  /** Footprint centre of a vehicle on the grid. */
  private centre(v: MjVehicle): Pt {
    const [dx, dy] = DELTA[v.dir];
    const back = length(v.kind) - 1;
    return [v.x + 0.5 - (dx * back) / 2, v.y + 0.5 - (dy * back) / 2];
  }

  private drawCars(): void {
    this.jam.removeChildren().forEach((c) => c.destroy({ children: true }));
    this.cars = [];
    this.level.vehicles.forEach((v, i) => {
      const car = this.drawVehicle(v);
      const [cx, cy] = this.centre(v);
      const [sx, sy] = this.iso(cx, cy);
      car.position.set(sx, sy);
      car.zIndex = cx + cy;
      car.visible = this.snap.onGrid[i] ?? false;
      car.eventMode = car.visible ? "static" : "none";
      car.cursor = "pointer";
      car.on("pointertap", () => this.options.onTap(i));
      this.jam.addChild(car);
      this.cars.push(car);
    });
  }

  // ----------------------------------------------------------- platform

  private figureAt(i: number): Pt {
    const { figure, queueY, queueH } = this.layout;
    return [16 + figure * 0.7 + i * figure * 1.05, queueY + queueH * 0.62];
  }

  private drawFigure(color: number | null): Container {
    const f = new Container();
    const g = new Graphics();
    const s = this.layout.figure;
    const fill = color === null ? 0x4b5578 : mjColor(color).color;
    g.ellipse(0, s * 0.5, s * 0.32, s * 0.1).fill({ color: 0x000000, alpha: 0.35 });
    g.roundRect(-s * 0.24, -s * 0.2, s * 0.48, s * 0.66, s * 0.2).fill(fill);
    g.roundRect(-s * 0.24, -s * 0.2, s * 0.48, s * 0.2, s * 0.1).fill({ color: 0xffffff, alpha: 0.18 });
    g.circle(0, -s * 0.42, s * 0.19).fill(color === null ? 0x6b7499 : 0xf5d0b0);
    f.addChild(g);
    if (color === null) {
      const q = new Text({ text: "?", style: { fill: 0xcbd5e1, fontSize: s * 0.36, fontWeight: "800" } });
      q.anchor.set(0.5);
      q.position.set(0, s * 0.12);
      f.addChild(q);
    } else if (this.options.symbols) {
      const t = new Text({ text: mjColor(color).symbol, style: { fill: 0x0b1020, fontSize: s * 0.3, fontWeight: "900" } });
      t.anchor.set(0.5);
      t.position.set(0, s * 0.12);
      f.addChild(t);
    }
    return f;
  }

  private drawPlatform(): void {
    this.platform.removeChildren().forEach((c) => c.destroy({ children: true }));
    const W = this.app.screen.width;
    const { queueY, queueH, figure } = this.layout;
    const g = new Graphics();
    g.roundRect(8, queueY, W - 16, queueH, 16).fill(PLATFORM);
    g.rect(8, queueY + queueH - 10, W - 16, 3).fill({ color: TACTILE, alpha: 0.85 });
    this.platform.addChild(g);

    const fits = Math.max(1, Math.floor((W - 24 - figure * 3.4) / (figure * 1.05)));
    const shown = this.snap.waiting.slice(0, Math.min(fits, this.level.visible));
    this.figures = shown.map((c, i) => {
      const f = this.drawFigure(c);
      f.position.set(...this.figureAt(i));
      this.platform.addChild(f);
      return f;
    });
    const more = this.snap.remaining - shown.length;
    // Beyond the visible count the level hides who comes next: show a "?" commuter.
    const secret = this.snap.remaining > this.level.visible;
    if (secret) {
      const next = this.drawFigure(null);
      next.position.set(...this.figureAt(shown.length));
      next.alpha = 0.8;
      this.platform.addChild(next);
    }
    if (more > 0) {
      const label = new Text({
        text: `+${more}`,
        style: { fill: 0xcbd5e1, fontSize: Math.max(11, figure * 0.5), fontWeight: "800" },
      });
      label.anchor.set(1, 0.5);
      label.position.set(W - 18, queueY + queueH * 0.55);
      this.platform.addChild(label);
    }
    const front = new Text({ text: "NEXT", style: { fill: TACTILE, fontSize: 10, fontWeight: "800", letterSpacing: 1 } });
    front.position.set(16, queueY + 5);
    this.platform.addChild(front);
  }

  // ----------------------------------------------------------------- bays

  private bayRect(i: number, count = this.snap.bays.length) {
    const W = this.app.screen.width;
    const gap = 8;
    const w = Math.min(130, (W - 16 - gap * (count - 1)) / count);
    const total = w * count + gap * (count - 1);
    return { x: (W - total) / 2 + i * (w + gap), y: this.layout.baysY, w, h: this.layout.baysH };
  }

  /** Scale that fits a vehicle (facing north, up-right) inside a bay. */
  private bayScale(kind: MjKind, bay: { w: number; h: number }): number {
    const len = length(kind);
    const t = this.layout.tile;
    const wide = (len * 0.5 + 0.5) * t;
    const tall = (len * 0.25 + 0.6) * t;
    return Math.min(1.6, (bay.w * 0.86) / wide, (bay.h * 0.6) / tall);
  }

  private drawBays(): void {
    this.bayLayer.removeChildren().forEach((c) => c.destroy({ children: true }));
    this.bayCars.clear();
    this.snap.bays.forEach(([vehicle, riders], i) => {
      const r = this.bayRect(i);
      const g = new Graphics();
      g.roundRect(r.x, r.y, r.w, r.h, 14).fill(0x171c2c).stroke({ width: 2, color: vehicle >= 0 ? 0x5b6690 : 0x2f3858 });
      g.rect(r.x + 10, r.y + r.h - 8, r.w - 20, 2).fill({ color: 0xe2e8f0, alpha: 0.5 });
      this.bayLayer.addChild(g);
      const num = new Text({ text: `${i + 1}`, style: { fill: 0x5b6690, fontSize: 11, fontWeight: "800" } });
      num.position.set(r.x + 8, r.y + 6);
      this.bayLayer.addChild(num);
      const v = this.level.vehicles[vehicle];
      if (!v) return;
      const car = this.drawVehicle({ ...v, dir: "n" }, this.bayScale(v.kind, r));
      car.position.set(r.x + r.w / 2, r.y + r.h * 0.5);
      this.bayLayer.addChild(car);
      this.bayCars.set(i, car);
      const seats = new Text({
        text: `${riders}/${riderCount(v.kind)}`,
        style: { fill: 0xffffff, fontSize: Math.max(11, Math.min(15, r.w * 0.14)), fontWeight: "800" },
      });
      seats.anchor.set(0.5, 1);
      seats.position.set(r.x + r.w / 2, r.y + r.h - 12);
      this.bayLayer.addChild(seats);
      car.label = `seats-${i}`;
      (car as Container & { seatText?: Text }).seatText = seats;
    });
  }

  // ------------------------------------------------------------ animation

  private ms(n: number): number {
    return this.fast ? 0 : n;
  }

  /** A tween that stops touching its targets once they are destroyed (resize, undo). */
  private tw(ms: number, targets: Container[], fn: (t: number) => void, easing?: (t: number) => number) {
    const gen = this.generation;
    return tween(
      this.app,
      this.ms(ms),
      (t) => {
        if (!this.destroyed && gen === this.generation && targets.every((o) => !o.destroyed)) fn(t);
      },
      easing,
    );
  }

  private async animate(kind: number, a: number, b: number, after: MjSnapshot): Promise<void> {
    if (kind === 0 || kind === 1) await this.animatePark(a, b, kind === 1, after);
    else if (kind === 2) await this.animateBoard(a, b);
    else if (kind === 3) await this.animateDepart(a);
    else if (kind === 4) {
      this.snap = { ...this.snap, bays: [...this.snap.bays, [-1, 0]] };
      this.drawBays();
    } else if (kind === 5) {
      this.snap = { ...this.snap, waiting: after.waiting };
      this.drawPlatform();
      await this.tw(260, this.figures, (t) => {
        this.figures.forEach((f, i) => (f.y = this.figureAt(i)[1] - Math.sin(t * Math.PI) * 10));
      });
    }
  }

  private async animatePark(vehicle: number, bay: number, lifted: boolean, after: MjSnapshot): Promise<void> {
    const car = this.cars[vehicle];
    const v = this.level.vehicles[vehicle];
    if (!car || !v) return;
    car.eventMode = "none";
    car.zIndex = 1000;
    const [dx, dy] = DELTA[v.dir];
    const x0 = car.x;
    const y0 = car.y;
    if (lifted) {
      await this.tw(320, [car], (t) => {
        car.y = y0 - t * this.layout.tile * 1.4;
        car.scale.set(1 + t * 0.1);
      });
    } else {
      // Drive straight out of the lot, accelerating.
      const [cx, cy] = this.centre(v);
      const dist = dx > 0 ? this.level.width - cx + 1 : dx < 0 ? cx + 1 : dy > 0 ? this.level.height - cy + 1 : cy + 1;
      const [sx, sy] = this.vec(dx * dist, dy * dist);
      await this.tw(
        180 + dist * 45,
        [car],
        (t) => {
          car.x = x0 + sx * t;
          car.y = y0 + sy * t;
        },
        (t) => t * t,
      );
    }
    if (car.destroyed) return;
    // Into the bay: the bay's own drawing takes over once it lands.
    const slot = this.bayRect(bay, Math.max(after.bays.length, bay + 1));
    const tx = slot.x + slot.w / 2;
    const ty = slot.y + slot.h * 0.5;
    const fx = car.x;
    const fy = car.y;
    const s0 = car.scale.x;
    const s1 = this.bayScale(v.kind, slot);
    this.bayLayer.addChild(car);
    await this.tw(
      300,
      [car],
      (t) => {
        car.x = lerp(fx, tx, t);
        car.y = lerp(fy, ty, t) - Math.sin(t * Math.PI) * this.layout.tile * 0.6;
        car.scale.set(lerp(s0, s1, t));
        car.alpha = 1 - t * 0.3;
      },
      ease.inOutCubic,
    );
    if (!car.destroyed) car.destroy({ children: true });
    this.cars[vehicle] = new Container();
    const bays = [...this.snap.bays];
    while (bays.length <= bay) bays.push([-1, 0]);
    bays[bay] = [vehicle, 0];
    const onGrid = [...this.snap.onGrid];
    onGrid[vehicle] = false;
    this.snap = { ...this.snap, bays, onGrid };
    this.drawBays();
  }

  private async animateBoard(bay: number, vehicle: number): Promise<void> {
    const f = this.figures.shift();
    const r = this.bayRect(bay);
    const bays = [...this.snap.bays];
    const [, riders] = bays[bay] ?? [vehicle, 0];
    bays[bay] = [vehicle, riders + 1];
    this.snap = { ...this.snap, bays, waiting: this.snap.waiting.slice(1), remaining: this.snap.remaining - 1 };
    // Long queues (49-seat buses) board quicker so play never waits.
    const speed = Math.max(40, 150 - this.snap.remaining);
    if (f) {
      const fx = f.x;
      const fy = f.y;
      const tx = r.x + r.w / 2;
      const ty = r.y + r.h * 0.45;
      f.zIndex = 10;
      this.fx.addChild(f);
      const shifting = this.figures.map((fig) => fig.x);
      await this.tw(speed + 60, [f, ...this.figures], (t) => {
        f.x = lerp(fx, tx, t);
        f.y = lerp(fy, ty, t) - Math.sin(t * Math.PI) * 40;
        f.scale.set(lerp(1, 0.55, t), lerp(1, 0.55, t) * (1 + Math.sin(t * Math.PI) * 0.15));
        this.figures.forEach((fig, i) => (fig.x = lerp(shifting[i] ?? fig.x, this.figureAt(i)[0], t)));
      });
      if (!f.destroyed) f.destroy({ children: true });
    }
    const car = this.bayCars.get(bay) as (Container & { seatText?: Text }) | undefined;
    const v = this.level.vehicles[vehicle];
    if (car?.seatText && !car.seatText.destroyed && v) car.seatText.text = `${riders + 1}/${riderCount(v.kind)}`;
    if (car) {
      const s = car.scale.x;
      void this.tw(140, [car], (t) => car.scale.set(s, s * (1 - Math.sin(t * Math.PI) * 0.06)));
    }
  }

  private async animateDepart(bay: number): Promise<void> {
    const car = this.bayCars.get(bay);
    if (car) {
      const x0 = car.x;
      const y0 = car.y;
      this.puff(x0, y0);
      await this.tw(
        380,
        [car],
        (t) => {
          car.x = x0 + t * this.layout.tile * 2.2;
          car.y = y0 - t * this.layout.tile * 1.1;
          car.alpha = 1 - t;
        },
        (t) => t * t,
      );
    }
    const bays = [...this.snap.bays];
    bays[bay] = [-1, 0];
    this.snap = { ...this.snap, bays };
    this.drawBays();
  }

  /** Little confetti burst when a full vehicle leaves. */
  private puff(x: number, y: number): void {
    if (this.fast) return;
    for (let i = 0; i < 10; i++) {
      const p = new Graphics();
      p.circle(0, 0, 2 + (i % 3)).fill(mjColor(i).color);
      p.position.set(x, y);
      this.fx.addChild(p);
      const ang = (i / 10) * Math.PI * 2;
      const dist = 24 + (i % 4) * 8;
      void tween(this.app, 520, (t) => {
        p.x = x + Math.cos(ang) * dist * t;
        p.y = y + Math.sin(ang) * dist * t + t * t * 20;
        p.alpha = 1 - t;
      }).then(() => p.destroy());
    }
  }
}

