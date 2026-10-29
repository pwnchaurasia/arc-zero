import { Application, Container, Graphics, Rectangle, Text } from "pixi.js";

import type { Board } from "../../api/types";
import { water } from "../colors";
import { createPixi, ease, lerp, prefersReducedMotion, tween } from "../pixi";

const CAPACITY = 4;
const UNIT_RATIO = 0.78; // unit height / bottle width
const NECK_RATIO = 0.4;
const GLASS = 0xcbd5ff;

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
}

export interface WaterSortViewOptions {
  onTap: (index: number) => void;
  symbols: boolean;
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
    const heightRatio = CAPACITY * UNIT_RATIO + NECK_RATIO;
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
    for (const b of this.bottles) b.root.destroy({ children: true });
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

      const liquid = new Graphics();
      const mask = new Graphics().roundRect(3, 3, w - 6, h - 6, w * 0.3).fill(0xffffff);
      liquid.mask = mask;
      const glass = new Graphics();
      const symbols = new Container();
      root.addChild(liquid, mask, symbols, glass);
      this.app.stage.addChild(root);
      this.bottles.push({ root, glass, liquid, symbols });
      this.drawGlass(i);
      this.drawLiquid(i);
    });
    if (this.selected !== null) this.moveHome(this.selected, true, 0);
  }

  private drawGlass(i: number): void {
    const b = this.bottles[i];
    if (!b) return;
    const { w, h } = this.layout;
    b.glass
      .clear()
      .roundRect(0, 0, w, h, w * 0.32)
      .fill({ color: GLASS, alpha: 0.06 })
      .stroke({ width: Math.max(2, w * 0.05), color: GLASS, alpha: 0.75 });
    // A highlight streak makes the glass read as glass.
    b.glass
      .roundRect(w * 0.16, h * 0.18, w * 0.08, h * 0.55, w * 0.04)
      .fill({ color: 0xffffff, alpha: 0.12 });
  }

  private drawLiquid(i: number): void {
    const b = this.bottles[i];
    const units = this.board[i];
    if (!b || !units) return;
    const { w, h, unit } = this.layout;
    b.liquid.clear();
    b.symbols.removeChildren().forEach((c) => c.destroy());
    units.forEach((colorId, k) => {
      const y = h - (k + 1) * unit - 4;
      const { color, symbol } = water(colorId);
      b.liquid.rect(0, y, w, unit + 0.5).fill(color);
      b.liquid.rect(0, y, w, Math.max(2, unit * 0.12)).fill({ color: 0xffffff, alpha: 0.18 });
      if (this.options.symbols) {
        const t = new Text({
          text: symbol,
          style: { fontSize: unit * 0.5, fill: 0x0b1020, fontWeight: "700" },
        });
        t.anchor.set(0.5);
        t.alpha = 0.7;
        t.position.set(w / 2, y + unit / 2);
        b.symbols.addChild(t);
      }
    });
  }

  private moveHome(i: number, lifted: boolean, ms = 120): void {
    const b = this.bottles[i];
    const home = this.layout.homes[i];
    if (!b || !home) return;
    const y0 = b.root.y;
    const y1 = home.y - (lifted ? this.layout.unit * 0.55 : 0);
    void tween(this.app, ms, (t) => {
      b.root.y = lerp(y0, y1, t);
    });
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
    const k = fast ? 0.45 : 1;
    const { w, unit, h } = this.layout;
    const colorId = this.board[from]?.at(-1) ?? 0;
    const color = water(colorId).color;
    this.animating.add(from);
    src.root.zIndex = 10;

    const side = srcHome.x <= dstHome.x ? -1 : 1;
    const start = { x: src.root.x, y: src.root.y };
    const mouth = { x: dstHome.x + side * w * 0.42, y: dstHome.y - unit * 1.35 };
    const tilt = -side * (Math.PI / 180) * 72;

    await tween(this.app, 170 * k, (t) => {
      src.root.position.set(lerp(start.x, mouth.x, t), lerp(start.y, mouth.y, t));
      src.root.rotation = lerp(0, tilt * 0.45, t);
    });
    await tween(this.app, 110 * k, (t) => {
      src.root.rotation = lerp(tilt * 0.45, tilt, t);
    });

    // Stream from the mouth down into the target, then swap in the new levels.
    const stream = new Graphics();
    stream.zIndex = 9;
    this.app.stage.addChild(stream);
    const fillAfter = after[to]?.length ?? 0;
    const surfaceY = dstHome.y + h - fillAfter * unit;
    await tween(this.app, 220 * k, (t) => {
      stream
        .clear()
        .rect(mouth.x - w * 0.07, mouth.y, w * 0.14, (surfaceY - mouth.y) * Math.min(1, t * 2))
        .fill({ color, alpha: 1 - Math.max(0, t - 0.7) * 3 });
      if (t > 0.35 && this.board !== after) {
        this.board = after;
        this.drawLiquid(from);
        this.drawLiquid(to);
      }
    });
    stream.destroy();
    this.board = after;
    this.drawLiquid(from);
    this.drawLiquid(to);

    const lifted = this.selected === from;
    await tween(this.app, 170 * k, (t) => {
      src.root.rotation = lerp(tilt, 0, t);
      src.root.position.set(
        lerp(mouth.x, srcHome.x, t),
        lerp(mouth.y, srcHome.y - (lifted ? unit * 0.55 : 0), t),
      );
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
