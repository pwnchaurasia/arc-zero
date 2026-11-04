import { Application, Container, Graphics, Point, Rectangle, Text } from "pixi.js";

import type { Board } from "../../api/types";
import { water } from "../colors";
import { createPixi, ease, lerp, prefersReducedMotion, tween } from "../pixi";

/** A layer the player hasn't uncovered yet (masked boards from the server). */
export const HIDDEN = 255;
const HIDDEN_COLOR = 0x2b3352;
const UNIT_RATIO = 0.78; // unit height / bottle width
const NECK_RATIO = 0.4;
const GLASS = 0xcbd5ff;

/** A level drawn with a partly full top layer, while a pour is under way. */
interface Partial {
  /** Units still to leave the top (source bottle), 0..n. */
  drain?: number;
  /** Units of `colorId` already arrived on top (target bottle). */
  fill?: { colorId: number; amount: number };
}

/** A test tube: straight walls, a round bottom, open top. `inset` shrinks it to the inside. */
function tube(g: Graphics, w: number, h: number, inset = 0): Graphics {
  const r = w / 2 - inset;
  return g
    .moveTo(inset, inset * 0.5)
    .lineTo(inset, h - w / 2)
    .arc(w / 2, h - w / 2, r, Math.PI, 0, true)
    .lineTo(w - inset, inset * 0.5)
    .closePath();
}

/** Mixes a colour towards white (`k` > 0) or black (`k` < 0). */
function shade(color: number, k: number): number {
  const ch = (shift: number) => {
    const c = (color >> shift) & 0xff;
    return Math.round(k >= 0 ? c + (255 - c) * k : c * (1 + k));
  };
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}

interface Layout {
  w: number;
  unit: number;
  h: number;
  homes: { x: number; y: number }[];
}

interface BottleSprite {
  root: Container;
  glass: Graphics;
  liquid: Graphics;
  symbols: Container;
  shadow: Graphics;
}

export interface WaterSortViewOptions {
  onTap: (index: number) => void;
  symbols: boolean;
  /** Units a bottle holds on this level (4 to 6). */
  capacity: number;
}

/**
 * Renders bottles and animates pours. Purely visual: the controller owns the
 * rules (via the WASM engine) and tells the view what happened.
 */
export class WaterSortView {
  private readonly bottles: BottleSprite[] = [];
  /** Fixed tap targets at each bottle's home slot, so taps never hit a bottle in flight. */
  private readonly slots: Container[] = [];
  private readonly overlay = new Graphics();
  private layout: Layout = { w: 0, unit: 0, h: 0, homes: [] };
  private board: Board;
  private selected: number | null = null;
  private hint: [number, number] | null = null;
  private queue: Promise<void> = Promise.resolve();
  private pending = 0;
  private animating = new Set<number>();
  private hintPulse = 0;
  private destroyed = false;

  private constructor(
    private readonly app: Application,
    board: Board,
    private options: WaterSortViewOptions,
  ) {
    this.board = board.map((b) => [...b]);
    app.stage.sortableChildren = true;
    this.overlay.zIndex = 50;
    app.stage.addChild(this.overlay);
    this.build();
    app.renderer.on("resize", this.relayout);
    app.ticker.add(this.animateHint);
  }

  static async create(host: HTMLElement, board: Board, options: WaterSortViewOptions) {
    return new WaterSortView(await createPixi(host), board, options);
  }

  destroy(): void {
    this.destroyed = true;
    this.app.renderer.off("resize", this.relayout);
    this.app.ticker.remove(this.animateHint);
    this.app.destroy({ removeView: true }, { children: true });
  }

  setSymbols(on: boolean): void {
    this.options = { ...this.options, symbols: on };
    this.bottles.forEach((_, i) => this.drawLiquid(i));
  }

  /**
   * Shows colours the server just uncovered, without disturbing anything else.
   * Bottles whose hidden layers changed get a quick flash.
   */
  reveal(board: Board): void {
    const changed = new Set<number>();
    board.forEach((units, i) => {
      const before = this.board[i] ?? [];
      if (units.some((c, k) => before[k] === HIDDEN && c !== HIDDEN)) changed.add(i);
    });
    if (board.length !== this.board.length) {
      this.setBoard(board);
      return;
    }
    this.board = board.map((b) => [...b]);
    for (const i of changed) {
      this.drawLiquid(i);
      const b = this.bottles[i];
      if (!b) continue;
      void tween(this.app, 260, (t) => {
        b.liquid.alpha = 0.55 + 0.45 * t;
      });
    }
  }

  /** Replaces the whole board without animation (start, undo, restart). */
  setBoard(board: Board): void {
    this.queue = Promise.resolve();
    this.pending = 0;
    this.animating.clear();
    this.board = board.map((b) => [...b]);
    this.selected = null;
    this.hint = null;
    this.build();
  }

  select(index: number | null): void {
    const prev = this.selected;
    this.selected = index;
    if (prev !== null && prev !== index && !this.animating.has(prev)) this.moveHome(prev, false);
    if (index !== null && !this.animating.has(index)) this.moveHome(index, true);
  }

  showHint(move: [number, number] | null): void {
    this.hint = move;
    if (!move) this.overlay.clear();
  }

  shake(index: number): void {
    const b = this.bottles[index];
    if (!b || this.animating.has(index)) return;
    const x0 = b.root.x;
    void tween(this.app, 260, (t) => {
      b.root.x = x0 + Math.sin(t * Math.PI * 6) * (1 - t) * this.layout.w * 0.12;
    }, (t) => t);
  }

  /** Queues a pour animation; `after` is the board once the pour has happened. */
  pour(from: number, to: number, after: Board): Promise<void> {
    const snapshot = after.map((b) => [...b]);
    this.pending += 1;
    this.queue = this.queue.then(() => this.animatePour(from, to, snapshot));
    return this.queue;
  }

  /** Small burst over a bottle that just became complete. */
  celebrate(index: number): void {
    const b = this.bottles[index];
    const colorId = this.board[index]?.[0];
    if (!b || colorId === undefined || prefersReducedMotion()) return;
    const { w, unit } = this.layout;
    const color = water(colorId).color;
    for (let i = 0; i < 10; i++) {
      const p = new Graphics().circle(0, 0, w * 0.06).fill(color);
      p.zIndex = 60;
      p.position.set(b.root.x, b.root.y - unit * 0.2);
      this.app.stage.addChild(p);
      const angle = (i / 10) * Math.PI * 2;
      const dist = w * (0.8 + Math.random() * 0.5);
      void tween(this.app, 520, (t) => {
        p.position.set(
          b.root.x + Math.cos(angle) * dist * t,
          b.root.y - unit * 0.2 + Math.sin(angle) * dist * t + t * t * unit,
        );
        p.alpha = 1 - t;
      }).then(() => p.destroy());
    }
  }

  // ------------------------------------------------------------ internals

  private computeLayout(): Layout {
    const n = this.board.length;
    const { width: W, height: H } = this.app.screen;
    const rows = n <= 6 ? 1 : 2;
    const perRow = Math.ceil(n / rows);
    const heightRatio = this.options.capacity * UNIT_RATIO + NECK_RATIO;
    const gap = 0.55;
    const byWidth = (W * 0.94) / (perRow + (perRow - 1) * gap);
    const byHeight = (H * 0.82) / (rows * heightRatio + (rows - 1) * 0.9);
    const w = Math.max(24, Math.min(byWidth, byHeight, 72));
    const unit = w * UNIT_RATIO;
    const h = w * heightRatio;
    const totalH = rows * h + (rows - 1) * w * 0.9;
    const top = (H - totalH) / 2 + unit * 0.4;
    const homes: { x: number; y: number }[] = [];
    for (let i = 0; i < n; i++) {
      const row = rows === 1 ? 0 : i < perRow ? 0 : 1;
      const inRow = row === 0 ? Math.min(perRow, n) : n - perRow;
      const col = row === 0 ? i : i - perRow;
      const rowW = inRow * w + (inRow - 1) * w * gap;
      homes.push({
        x: (W - rowW) / 2 + col * w * (1 + gap) + w / 2,
        y: top + row * (h + w * 0.9),
      });
    }
    return { w, unit, h, homes };
  }

  private readonly relayout = () => {
    if (!this.destroyed) this.build();
  };

  private build(): void {
    for (const b of this.bottles) {
      b.root.destroy({ children: true });
      b.shadow.destroy();
    }
    for (const slot of this.slots) slot.destroy();
    this.bottles.length = 0;
    this.slots.length = 0;
    this.layout = this.computeLayout();
    const { w, h, homes } = this.layout;

    this.board.forEach((_, i) => {
      const root = new Container();
      // Pivot at the mouth so pours tilt around it.
      root.pivot.set(w / 2, 0);
      const home = homes[i] ?? { x: 0, y: 0 };
      root.position.set(home.x, home.y);
      root.zIndex = 1;
      root.eventMode = "none";

      const slot = new Container();
      slot.position.set(home.x - w / 2, home.y);
      slot.zIndex = 100;
      slot.eventMode = "static";
      slot.cursor = "pointer";
      slot.hitArea = new Rectangle(-w * 0.25, -w * 0.9, w * 1.5, h + w * 1.2);
      slot.on("pointerdown", (e) => {
        e.stopPropagation();
        this.options.onTap(i);
      });
      this.app.stage.addChild(slot);
      this.slots.push(slot);

      // A soft shadow on the "table", which stays put when the bottle is lifted.
      const shadow = new Graphics()
        .ellipse(home.x, home.y + h + w * 0.06, w * 0.5, w * 0.11)
        .fill({ color: 0x000000, alpha: 0.35 });
      shadow.zIndex = 0;
      this.app.stage.addChild(shadow);

      const liquid = new Graphics();
      const mask = tube(new Graphics(), w, h, Math.max(2, w * 0.06)).fill(0xffffff);
      liquid.mask = mask;
      const glass = new Graphics();
      const symbols = new Container();
      root.addChild(liquid, mask, symbols, glass);
      this.app.stage.addChild(root);
      this.bottles.push({ root, glass, liquid, symbols, shadow });
      this.drawGlass(i);
      this.drawLiquid(i);
    });
    if (this.selected !== null) this.moveHome(this.selected, true, 0);
  }

  private drawGlass(i: number): void {
    const b = this.bottles[i];
    if (!b) return;
    const { w, h } = this.layout;
    const wall = Math.max(2, w * 0.045);
    const g = b.glass.clear();
    // The glass body: a faint tint inside, a bright rim of light along the edge.
    tube(g, w, h).fill({ color: GLASS, alpha: 0.07 });
    tube(g, w, h).stroke({ width: wall, color: GLASS, alpha: 0.8 });
    tube(g, w, h, wall).stroke({ width: Math.max(1, wall * 0.4), color: 0xffffff, alpha: 0.12 });
    // The lip at the top.
    g.roundRect(-w * 0.07, -w * 0.07, w * 1.14, w * 0.14, w * 0.07)
      .fill({ color: GLASS, alpha: 0.25 })
      .stroke({ width: Math.max(1.5, wall * 0.8), color: GLASS, alpha: 0.9 });
    // Highlights: a long streak on the left, a short glint on the right, a curve
    // in the round bottom. This is what makes it read as glass.
    g.moveTo(w * 0.22, w * 0.3)
      .lineTo(w * 0.22, h - w * 0.62)
      .stroke({ width: w * 0.09, color: 0xffffff, alpha: 0.28, cap: "round" });
    g.moveTo(w * 0.8, w * 0.35)
      .lineTo(w * 0.8, w * 0.95)
      .stroke({ width: w * 0.05, color: 0xffffff, alpha: 0.18, cap: "round" });
    const r = w * 0.34;
    g.moveTo(w / 2 + r * Math.cos(Math.PI * 0.62), h - w / 2 + r * Math.sin(Math.PI * 0.62))
      .arc(w / 2, h - w / 2, r, Math.PI * 0.62, Math.PI * 0.88)
      .stroke({
      width: w * 0.05,
      color: 0xffffff,
      alpha: 0.2,
      cap: "round",
    });
  }

  private drawLiquid(i: number, partial: Partial = {}): void {
    const b = this.bottles[i];
    const units = this.board[i];
    if (!b || !units) return;
    const { w, h, unit } = this.layout;
    const wall = Math.max(2, w * 0.06);
    b.liquid.clear();
    b.symbols.removeChildren().forEach((c) => c.destroy());

    // Layers bottom-up as (colour id, amount), with the pour in progress applied.
    const layers: [number, number][] = units.map((c) => [c, 1]);
    let drain = partial.drain ?? 0;
    for (let k = layers.length - 1; k >= 0 && drain > 0; k--) {
      const layer = layers[k];
      if (!layer) break;
      const take = Math.min(layer[1], drain);
      layer[1] -= take;
      drain -= take;
    }
    if (partial.fill && partial.fill.amount > 0) layers.push([partial.fill.colorId, partial.fill.amount]);

    // Liquid fills the round bottom too: its lowest point is the inside of the glass.
    let level = h - wall;
    let top: { y: number; color: number } | null = null;
    layers.forEach(([colorId, amount], k) => {
      if (amount <= 0.001) return;
      const height = unit * amount;
      const y = level - height;
      const whole = amount > 0.98 && (k < units.length || !partial.fill);
      if (colorId === HIDDEN) {
        // Unknown until uncovered: a dark layer with a question mark.
        b.liquid.rect(0, y, w, height + 0.5).fill(HIDDEN_COLOR);
        b.liquid.rect(0, y, w, 1).fill({ color: 0x000000, alpha: 0.35 });
        if (whole) {
          const q = new Text({ text: "?", style: { fontSize: unit * 0.55, fill: 0x8b95b8, fontWeight: "800" } });
          q.anchor.set(0.5);
          q.position.set(w / 2, y + unit / 2);
          b.symbols.addChild(q);
        }
        top = { y, color: HIDDEN_COLOR };
      } else {
        const { color, symbol } = water(colorId);
        b.liquid.rect(0, y, w, height + 0.5).fill(color);
        // Depth: darker towards the right wall, lighter on the left.
        b.liquid.rect(w * 0.62, y, w * 0.38, height + 0.5).fill({ color: 0x000000, alpha: 0.12 });
        b.liquid.rect(0, y, w * 0.3, height + 0.5).fill({ color: 0xffffff, alpha: 0.08 });
        if (this.options.symbols && whole) {
          const t = new Text({ text: symbol, style: { fontSize: unit * 0.5, fill: 0x0b1020, fontWeight: "700" } });
          t.anchor.set(0.5);
          t.alpha = 0.7;
          t.position.set(w / 2, y + unit / 2);
          b.symbols.addChild(t);
        }
        top = { y, color };
      }
      level = y;
    });
    // The surface: a lit, slightly curved meniscus on the top layer.
    const surface = top as { y: number; color: number } | null;
    if (surface) {
      b.liquid.ellipse(w / 2, surface.y, w / 2, Math.max(1.5, unit * 0.1)).fill(shade(surface.color, 0.35));
      b.liquid.ellipse(w * 0.42, surface.y, w * 0.22, Math.max(1, unit * 0.04)).fill({ color: 0xffffff, alpha: 0.35 });
    }
  }

  private moveHome(i: number, lifted: boolean, ms = 120): void {
    const b = this.bottles[i];
    const home = this.layout.homes[i];
    if (!b || !home) return;
    const y0 = b.root.y;
    const y1 = home.y - (lifted ? this.layout.unit * 0.55 : 0);
    // Lifting springs up a little; setting down eases in.
    void tween(this.app, lifted ? ms * 1.6 : ms * 1.3, (t) => {
      b.root.y = lerp(y0, y1, t);
    }, lifted ? ease.outBack : ease.inOutCubic);
  }

  private async animatePour(from: number, to: number, after: Board): Promise<void> {
    const src = this.bottles[from];
    const dst = this.bottles[to];
    const srcHome = this.layout.homes[from];
    const dstHome = this.layout.homes[to];
    if (this.destroyed || !src || !dst || !srcHome || !dstHome) {
      this.pending = Math.max(0, this.pending - 1);
      this.board = after;
      return;
    }
    const fast = this.pending > 1 || prefersReducedMotion();
    const k = fast ? 0.4 : 1;
    const { w, unit, h } = this.layout;
    const colorId = this.board[from]?.at(-1) ?? 0;
    const color = water(colorId).color;
    const amount = Math.max(1, (after[to]?.length ?? 0) - (this.board[to]?.length ?? 0));
    this.animating.add(from);
    src.root.zIndex = 10;

    const side = srcHome.x <= dstHome.x ? -1 : 1;
    const start = { x: src.root.x, y: src.root.y };
    const mouth = { x: dstHome.x + side * w * 0.5, y: dstHome.y - unit * 1.45 };
    const tilt = -side * (Math.PI / 180) * 74;
    // The lip the liquid leaves from: the side that tips down.
    const lip = new Point(side === -1 ? w : 0, 0);

    // Lift, then glide over in an arc while tipping.
    const peak = Math.min(start.y, mouth.y) - unit * 0.8;
    await tween(this.app, 300 * k, (t) => {
      const x = lerp(start.x, mouth.x, t);
      const y = (1 - t) * (1 - t) * start.y + 2 * (1 - t) * t * peak + t * t * mouth.y;
      src.root.position.set(x, y);
      src.root.rotation = lerp(0, tilt, ease.inOutCubic(Math.max(0, (t - 0.25) / 0.75)));
    }, ease.inOutCubic);

    // Pour: the stream arcs from the lip, the source drains as the target fills.
    const stream = new Graphics();
    stream.zIndex = 9;
    const splash = new Graphics();
    splash.zIndex = 9;
    this.app.stage.addChild(stream, splash);
    const before = this.board;
    const startLevel = dstHome.y + h - Math.max(2, w * 0.06) - (before[to]?.length ?? 0) * unit;
    await tween(this.app, (200 + 110 * amount) * k, (t) => {
      const poured = amount * Math.min(1, t * 1.15);
      this.drawLiquid(from, { drain: poured });
      this.drawLiquid(to, { fill: { colorId, amount: poured } });
      const from0 = src.root.toGlobal(lip);
      const surfaceY = startLevel - poured * unit;
      const x1 = dstHome.x + side * w * 0.05;
      // Thick in the middle of the pour, thinning as it starts and ends.
      const width = w * 0.13 * Math.sin(Math.min(1, t * 1.1) * Math.PI) + w * 0.03;
      const wobble = fast ? 0 : Math.sin(t * 40) * w * 0.015;
      stream
        .clear()
        .moveTo(from0.x, from0.y)
        .quadraticCurveTo(from0.x - side * w * 0.05 + wobble, (from0.y + surfaceY) / 2, x1, surfaceY)
        .stroke({ width, color, cap: "round" })
        .moveTo(from0.x, from0.y)
        .quadraticCurveTo(from0.x - side * w * 0.05 + wobble, (from0.y + surfaceY) / 2, x1, surfaceY)
        .stroke({ width: width * 0.35, color: shade(color, 0.45), alpha: 0.7, cap: "round" });
      splash.clear();
      if (!fast && t < 0.9) {
        for (let d = 0; d < 4; d++) {
          const a = t * 30 + d * 1.7;
          splash
            .circle(x1 + Math.cos(a) * w * 0.18, surfaceY - Math.abs(Math.sin(a)) * unit * 0.25, w * 0.035)
            .fill({ color: shade(color, 0.3), alpha: 0.8 });
        }
      }
    }, (t) => t);
    stream.destroy();
    splash.destroy();
    this.board = after;
    this.drawLiquid(from);
    this.drawLiquid(to);

    // Tip back and settle home.
    const lifted = this.selected === from;
    const end = { x: srcHome.x, y: srcHome.y - (lifted ? unit * 0.55 : 0) };
    await tween(this.app, 280 * k, (t) => {
      src.root.rotation = lerp(tilt, 0, Math.min(1, t * 1.4));
      src.root.position.set(lerp(mouth.x, end.x, t), lerp(mouth.y, end.y, t));
    }, ease.inOutCubic);
    src.root.zIndex = 1;
    this.animating.delete(from);
    this.pending = Math.max(0, this.pending - 1);
  }

  private readonly animateHint = () => {
    if (!this.hint) return;
    const [from, to] = this.hint;
    const a = this.bottles[from];
    const b = this.bottles[to];
    if (!a || !b) return;
    this.hintPulse += this.app.ticker.deltaMS / 1000;
    const alpha = 0.55 + Math.sin(this.hintPulse * 5) * 0.35;
    const { w, unit } = this.layout;
    const y = Math.min(a.root.y, b.root.y) - unit * 0.9;
    const x0 = a.root.x;
    const x1 = b.root.x;
    const head = w * 0.22;
    const dir = Math.sign(x1 - x0) || 1;
    this.overlay
      .clear()
      .moveTo(x0, a.root.y - unit * 0.3)
      .quadraticCurveTo((x0 + x1) / 2, y - unit, x1, b.root.y - unit * 0.45)
      .stroke({ width: Math.max(3, w * 0.08), color: 0xfacc15, alpha })
      .poly([
        x1, b.root.y - unit * 0.2,
        x1 - dir * head, b.root.y - unit * 0.2 - head * 1.2,
        x1 + dir * head * 0.3, b.root.y - unit * 0.2 - head * 1.4,
      ])
      .fill({ color: 0xfacc15, alpha });
  };
}
