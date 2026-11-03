import { Application, Container, type FederatedPointerEvent, Graphics, Text } from "pixi.js";

import type { GsPiece } from "../../api/types";
import { engine } from "../../engine/wasm";
import { drawBevelled } from "../brick-blast/bevel";
import { shade } from "../colors";
import { createPixi, ease, prefersReducedMotion, tween } from "../pixi";

const SIZE = 8;
/** The dragged shape floats this far (CSS px) above the finger, so the target stays visible. */
export const FINGER_OFFSET = 70;
/** Tray shapes are drawn at this share of the board's cell size. */
const TRAY_SCALE = 0.6;
/** On release, use where the shape was this long ago: lifting a finger nudges the point. */
const LIFT_SETTLE_MS = 90;

/** Block colours, index = engine colour id. */
export const GS_COLORS = [0xef4444, 0xf97316, 0xfacc15, 0x22c55e, 0x0ea5e9, 0x8b5cf6, 0x14b8a6];
const BOARD = 0x0c1533;
const BOARD_EDGE = 0x2b3d82;
const SLOT = 0x16224d;

let shapeRows: number[][] | null = null;

/** Every shape's rows (bit `c` = column `c`), from the engine. */
export function shapes(): number[][] {
  shapeRows ??= JSON.parse(engine.gsShapes()) as number[][];
  return shapeRows;
}

export function shapeCells(shape: number): [number, number][] {
  const out: [number, number][] = [];
  (shapes()[shape] ?? []).forEach((bits, r) => {
    for (let c = 0; c < SIZE; c++) if (bits & (1 << c)) out.push([r, c]);
  });
  return out;
}

export function shapeSize(shape: number): { w: number; h: number } {
  const rows = shapes()[shape] ?? [];
  const w = Math.max(0, ...rows.map((b) => 32 - Math.clz32(b)));
  return { w, h: rows.length };
}

/** The rules the view asks about while dragging; the controller answers from the engine. */
export interface GsRules {
  canPlace(slot: number, row: number, col: number): boolean;
  wouldClear(slot: number, row: number, col: number): [number, number];
  fits(slot: number): boolean;
}

export interface GridSnapViewOptions {
  rules: GsRules;
  onPlace: (slot: number, row: number, col: number) => void;
  /** Bomb assist: the cell the player picked. */
  onPick: (row: number, col: number) => void;
}

export interface Placement {
  rows: number;
  cols: number;
  points: number;
  combo: number;
}

interface Drag {
  slot: number;
  piece: Container;
  /** Recent targets, newest last: `[time, row, col]` (row -1 = off the board). */
  trail: [number, number, number][];
}

interface Particle {
  g: Graphics;
  vx: number;
  vy: number;
  life: number;
}

function drawBlock(g: Graphics, x: number, y: number, s: number, color: number): void {
  const i = Math.max(1, s * 0.04);
  drawBevelled(g, [x + i, y + i, x + s - i, y + i, x + s - i, y + s - i, x + i, y + s - i], color, Math.max(1, s * 0.04));
  g.roundRect(x + s * 0.2, y + s * 0.16, s * 0.28, s * 0.1, s * 0.05).fill({ color: 0xffffff, alpha: 0.35 });
}

/**
 * The 8 × 8 board and the tray of three shapes. Purely visual: the controller
 * owns the rules (WASM engine) and the server's truth, and tells the view what changed.
 */
export class GridSnapView {
  private readonly frame = new Graphics();
  private readonly blocks = new Graphics();
  private readonly ghost = new Graphics();
  private readonly trayLayer = new Container();
  private readonly top = new Container();
  private readonly fx = new Container();
  private cells: number[] = new Array<number>(SIZE * SIZE).fill(0);
  private tray: (GsPiece | null)[] = [null, null, null];
  private pieces: (Container | null)[] = [null, null, null];
  private cell = 0;
  private bx = 0;
  private by = 0;
  private trayY = 0;
  private trayH = 0;
  private slotSpan = 0;
  private drag: Drag | null = null;
  private locked = false;
  private picking = false;
  private pickAt: [number, number] | null = null;
  private keyGhost: [number, number, number] | null = null;
  private particles: Particle[] = [];
  private destroyed = false;
  private readonly fast = prefersReducedMotion();

  private constructor(
    private readonly app: Application,
    private readonly options: GridSnapViewOptions,
  ) {
    app.stage.addChild(this.frame, this.blocks, this.ghost, this.trayLayer, this.fx, this.top);
    app.stage.eventMode = "static";
    app.stage.hitArea = app.screen;
    app.stage.on("pointerdown", this.onDown);
    app.stage.on("pointermove", this.onMove);
    app.stage.on("pointerup", this.onUp);
    app.stage.on("pointerupoutside", this.onUp);
    app.renderer.on("resize", this.layout);
    app.ticker.add(this.animate);
    this.layout();
  }

  static async create(host: HTMLElement, options: GridSnapViewOptions): Promise<GridSnapView> {
    return new GridSnapView(await createPixi(host), options);
  }

  destroy(): void {
    this.destroyed = true;
    this.app.renderer.off("resize", this.layout);
    this.app.ticker.remove(this.animate);
    this.app.destroy({ removeView: true }, { children: true });
  }

  /** Shows the board and tray as they are now (no animation unless `deal`). */
  setState(cells: number[], tray: (GsPiece | null)[], deal = false): void {
    this.cancelDrag();
    const changed = tray.some((p, i) => !samePiece(p, this.tray[i] ?? null));
    this.cells = cells.slice();
    this.tray = tray.slice();
    this.drawBlocks();
    if (changed || !deal) this.buildTray(deal && changed);
    this.refreshFit();
  }

  /** No dragging while the server is dealing or a card is open. */
  setLocked(on: boolean): void {
    this.locked = on;
    if (on) this.cancelDrag();
  }

  /** Bomb assist: the next tap on the board picks the centre of the 3 × 3 area. */
  setPicking(on: boolean): void {
    this.picking = on;
    this.pickAt = null;
    this.cancelDrag();
    this.drawGhost();
  }

  /** Keyboard play: shows where the shape in `slot` would go, or hides it. */
  showKeyGhost(at: [number, number, number] | null): void {
    this.keyGhost = at;
    this.drawGhost();
  }

  /** Dims shapes that fit nowhere. */
  refreshFit(): void {
    this.pieces.forEach((p, i) => {
      if (p && p !== this.drag?.piece) p.alpha = this.options.rules.fits(i) ? 1 : 0.35;
    });
  }

  /**
   * Plays a placement the controller already applied to its engine: the shape
   * drops in, full lines flash and burst, then the board shows `after`.
   */
  async place(slot: number, row: number, col: number, piece: GsPiece, result: Placement, after: number[]): Promise<void> {
    const old = this.pieces[slot];
    old?.destroy({ children: true });
    this.pieces[slot] = null;
    this.tray[slot] = null;
    for (const [r, c] of shapeCells(piece.shape)) this.cells[(row + r) * SIZE + col + c] = piece.color + 1;
    this.keyGhost = null;
    this.drawGhost();
    this.drawBlocks();

    const { w, h } = shapeSize(piece.shape);
    const cx = this.bx + (col + w / 2) * this.cell;
    const cy = this.by + (row + h / 2) * this.cell;
    this.popup(`+${result.points}`, cx, cy, result.rows || result.cols ? 0xfde047 : 0xe8ecff, 18);

    if (result.rows || result.cols) {
      const lines = popcount(result.rows) + popcount(result.cols);
      const flash = new Graphics();
      this.fx.addChild(flash);
      for (let i = 0; i < SIZE * SIZE; i++) {
        const r = Math.floor(i / SIZE);
        const c = i % SIZE;
        if (!(result.rows & (1 << r)) && !(result.cols & (1 << c))) continue;
        const x = this.bx + c * this.cell;
        const y = this.by + r * this.cell;
        flash.rect(x, y, this.cell, this.cell).fill({ color: 0xffffff, alpha: 0.85 });
        this.burst(x + this.cell / 2, y + this.cell / 2, GS_COLORS[(this.cells[i] || 1) - 1] ?? 0xffffff);
      }
      const praise =
        lines >= 4 ? "Unbelievable!" : lines === 3 ? "Amazing!" : lines === 2 ? "Great!" : result.combo >= 2 ? "Nice!" : null;
      if (praise) this.popup(praise, this.bx + 4 * this.cell, this.by + 3 * this.cell, 0xffffff, 30);
      if (result.combo >= 2) this.popup(`Combo ×${result.combo}`, this.bx + 4 * this.cell, this.by + 4.2 * this.cell, 0x38bdf8, 22);
      await tween(this.app, this.fast ? 0 : 260, (t) => {
        if (!flash.destroyed) flash.alpha = 1 - t;
      });
      flash.destroy();
    }
    if (this.destroyed) return;
    this.cells = after.slice();
    this.drawBlocks();
    this.refreshFit();
  }

  /** Bomb assist: a blast over the 3 × 3 area, then the board as it is now. */
  async explode(row: number, col: number, after: number[]): Promise<void> {
    const r0 = Math.min(Math.max(row, 1), SIZE - 2) - 1;
    const c0 = Math.min(Math.max(col, 1), SIZE - 2) - 1;
    const ring = new Graphics();
    this.fx.addChild(ring);
    const cx = this.bx + (c0 + 1.5) * this.cell;
    const cy = this.by + (r0 + 1.5) * this.cell;
    for (let r = r0; r < r0 + 3; r++) {
      for (let c = c0; c < c0 + 3; c++) {
        const v = this.cells[r * SIZE + c] ?? 0;
        if (v) this.burst(this.bx + (c + 0.5) * this.cell, this.by + (r + 0.5) * this.cell, GS_COLORS[v - 1] ?? 0xffffff);
      }
    }
    await tween(this.app, this.fast ? 0 : 320, (t) => {
      if (ring.destroyed) return;
      ring.clear();
      ring.circle(cx, cy, this.cell * (0.5 + 2.2 * t)).stroke({ width: this.cell * 0.3 * (1 - t), color: 0xfde047, alpha: 1 - t });
    });
    ring.destroy();
    if (this.destroyed) return;
    this.cells = after.slice();
    this.drawBlocks();
    this.refreshFit();
  }

  // ---------------------------------------------------------------- layout

  private readonly layout = () => {
    const { width: W, height: H } = this.app.screen;
    const pad = 12;
    this.trayH = Math.min(Math.max(H * 0.24, 110), 190);
    this.cell = Math.floor(Math.min((W - 2 * pad) / SIZE, (H - this.trayH - 2 * pad) / SIZE, 64));
    const bw = this.cell * SIZE;
    this.bx = Math.round((W - bw) / 2);
    this.by = Math.round(Math.max(pad, (H - this.trayH - bw) / 2));
    this.trayY = this.by + bw + this.trayH / 2;
    this.slotSpan = Math.min(W, bw + 2 * pad) / 3;
    this.drawFrame();
    this.drawBlocks();
    this.buildTray(false);
    this.refreshFit();
    this.drawGhost();
  };

  private slotX(slot: number): number {
    return this.app.screen.width / 2 + (slot - 1) * this.slotSpan;
  }

  private trayScale(shape: number): number {
    const { w, h } = shapeSize(shape);
    const fit = Math.min((this.slotSpan - 14) / Math.max(w, 1), (this.trayH - 20) / Math.max(h, 1));
    return Math.min(this.cell * TRAY_SCALE, fit) / this.cell;
  }

  // --------------------------------------------------------------- drawing

  private drawFrame(): void {
    const g = this.frame.clear();
    const bw = this.cell * SIZE;
    const m = Math.max(4, this.cell * 0.12);
    g.roundRect(this.bx - m, this.by - m, bw + 2 * m, bw + 2 * m, m * 1.6).fill(BOARD).stroke({ width: 2, color: BOARD_EDGE });
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        g.roundRect(this.bx + c * this.cell + 1.5, this.by + r * this.cell + 1.5, this.cell - 3, this.cell - 3, this.cell * 0.12).fill(SLOT);
      }
    }
    // The tray: a shallow tray under the board.
    const tw = this.slotSpan * 3 - 8;
    g.roundRect(this.app.screen.width / 2 - tw / 2, this.trayY - this.trayH / 2 + 8, tw, this.trayH - 16, 18).fill({ color: BOARD, alpha: 0.7 }).stroke({ width: 1.5, color: BOARD_EDGE, alpha: 0.7 });
  }

  private drawBlocks(): void {
    const g = this.blocks.clear();
    this.cells.forEach((v, i) => {
      if (!v) return;
      const x = this.bx + (i % SIZE) * this.cell;
      const y = this.by + Math.floor(i / SIZE) * this.cell;
      drawBlock(g, x, y, this.cell, GS_COLORS[v - 1] ?? 0xffffff);
    });
  }

  private makePiece(p: GsPiece): Container {
    const g = new Graphics();
    const { w, h } = shapeSize(p.shape);
    for (const [r, c] of shapeCells(p.shape)) {
      drawBlock(g, (c - w / 2) * this.cell, (r - h / 2) * this.cell, this.cell, GS_COLORS[p.color] ?? 0xffffff);
    }
    const box = new Container();
    box.addChild(g);
    return box;
  }

  private buildTray(animate: boolean): void {
    this.drag = null;
    this.pieces.forEach((p) => p?.destroy({ children: true }));
    this.pieces = this.tray.map((p, i) => {
      if (!p) return null;
      const box = this.makePiece(p);
      const s = this.trayScale(p.shape);
      box.position.set(this.slotX(i), this.trayY);
      box.scale.set(s);
      this.trayLayer.addChild(box);
      if (animate && !this.fast) {
        box.alpha = 0;
        box.scale.set(s * 0.4);
        void tween(this.app, 260 + i * 70, (t) => {
          if (box.destroyed) return;
          box.alpha = t;
          box.scale.set(s * (0.4 + 0.6 * t));
        }, ease.outBack);
      }
      return box;
    });
  }

  /** The cell under a point on the board, or null. */
  private cellAt(x: number, y: number): [number, number] | null {
    const c = Math.floor((x - this.bx) / this.cell);
    const r = Math.floor((y - this.by) / this.cell);
    return r >= 0 && r < SIZE && c >= 0 && c < SIZE ? [r, c] : null;
  }

  /** Top-left cell for a shape centred at `(x, y)`; may be off the board. */
  private anchor(slot: number, x: number, y: number): [number, number] {
    const p = this.tray[slot];
    const { w, h } = shapeSize(p?.shape ?? 0);
    return [Math.round((y - (h * this.cell) / 2 - this.by) / this.cell), Math.round((x - (w * this.cell) / 2 - this.bx) / this.cell)];
  }

  private drawGhost(): void {
    const g = this.ghost.clear();
    if (this.picking && this.pickAt) {
      const [row, col] = this.pickAt;
      const r0 = Math.min(Math.max(row, 1), SIZE - 2) - 1;
      const c0 = Math.min(Math.max(col, 1), SIZE - 2) - 1;
      g.roundRect(this.bx + c0 * this.cell, this.by + r0 * this.cell, this.cell * 3, this.cell * 3, this.cell * 0.2)
        .fill({ color: 0xfde047, alpha: 0.25 })
        .stroke({ width: 3, color: 0xfde047 });
      return;
    }
    const target = this.drag ? this.dragTarget() : this.keyGhost;
    if (!target) return;
    const [slot, row, col] = target;
    const p = this.tray[slot];
    if (!p || row < 0) return;
    const { w, h } = shapeSize(p.shape);
    if (row + h > SIZE || col < 0 || col + w > SIZE) return;
    const ok = this.options.rules.canPlace(slot, row, col);
    const color = GS_COLORS[p.color] ?? 0xffffff;
    if (ok) {
      // Lines this would clear light up in the shape's colour.
      const [rows, cols] = this.options.rules.wouldClear(slot, row, col);
      for (let i = 0; i < SIZE * SIZE; i++) {
        const r = Math.floor(i / SIZE);
        const c = i % SIZE;
        if (!(rows & (1 << r)) && !(cols & (1 << c))) continue;
        g.rect(this.bx + c * this.cell, this.by + r * this.cell, this.cell, this.cell).fill({ color, alpha: 0.35 });
      }
    }
    for (const [r, c] of shapeCells(p.shape)) {
      const x = this.bx + (col + c) * this.cell;
      const y = this.by + (row + r) * this.cell;
      g.roundRect(x + 2, y + 2, this.cell - 4, this.cell - 4, this.cell * 0.15)
        .fill({ color: ok ? shade(color, 0.2) : 0xef4444, alpha: ok ? 0.4 : 0.2 })
        .stroke({ width: 2, color: ok ? 0xffffff : 0xef4444, alpha: ok ? 0.7 : 0.4 });
    }
  }

  // ------------------------------------------------------------------ input

  private slotAt(x: number, y: number): number | null {
    if (Math.abs(y - this.trayY) > this.trayH / 2) return null;
    const slot = Math.floor((x - (this.app.screen.width / 2 - 1.5 * this.slotSpan)) / this.slotSpan);
    return slot >= 0 && slot < 3 && this.pieces[slot] ? slot : null;
  }

  /** `[slot, row, col]` for the dragged shape, settled against the finger's lift. */
  private dragTarget(settled = false): [number, number, number] | null {
    const d = this.drag;
    if (!d || d.trail.length === 0) return null;
    let pick = d.trail[d.trail.length - 1];
    if (settled) {
      const cutoff = performance.now() - LIFT_SETTLE_MS;
      for (let i = d.trail.length - 1; i >= 0; i--) {
        const t = d.trail[i];
        if (t && t[0] <= cutoff) {
          pick = t;
          break;
        }
      }
    }
    return pick ? [d.slot, pick[1], pick[2]] : null;
  }

  private moveDrag(x: number, y: number): void {
    const d = this.drag;
    if (!d) return;
    if (d.piece.destroyed) {
      this.drag = null;
      return;
    }
    d.piece.position.set(x, y - FINGER_OFFSET);
    const [row, col] = this.anchor(d.slot, x, y - FINGER_OFFSET);
    const last = d.trail[d.trail.length - 1];
    if (!last || last[1] !== row || last[2] !== col) {
      d.trail.push([performance.now(), row, col]);
      if (d.trail.length > 12) d.trail.shift();
      this.drawGhost();
    }
  }

  private readonly onDown = (e: FederatedPointerEvent) => {
    const { x, y } = e.global;
    if (this.picking) {
      this.pickAt = this.cellAt(x, y);
      this.drawGhost();
      return;
    }
    if (this.locked || this.drag) return;
    const slot = this.slotAt(x, y);
    if (slot === null) return;
    const piece = this.pieces[slot];
    if (!piece) return;
    this.keyGhost = null;
    this.trayLayer.removeChild(piece);
    this.top.addChild(piece);
    piece.alpha = 1;
    this.drag = { slot, piece, trail: [] };
    const from = piece.scale.x;
    void tween(this.app, this.fast ? 0 : 120, (t) => {
      if (!piece.destroyed) piece.scale.set(from + (1 - from) * t);
    });
    this.moveDrag(x, y);
  };

  private readonly onMove = (e: FederatedPointerEvent) => {
    if (this.picking) {
      if (this.pickAt) {
        this.pickAt = this.cellAt(e.global.x, e.global.y) ?? this.pickAt;
        this.drawGhost();
      }
      return;
    }
    this.moveDrag(e.global.x, e.global.y);
  };

  private readonly onUp = () => {
    if (this.picking) {
      const at = this.pickAt;
      if (at) this.options.onPick(at[0], at[1]);
      return;
    }
    const d = this.drag;
    if (!d) return;
    const target = this.dragTarget(true);
    const latest = this.dragTarget();
    // Prefer the settled spot; fall back to the latest if only that one is legal.
    const choice = [target, latest].find((t) => t && this.options.rules.canPlace(t[0], t[1], t[2]));
    if (choice) {
      this.drag = null;
      this.drawGhost();
      this.options.onPlace(choice[0], choice[1], choice[2]);
      return;
    }
    this.cancelDrag();
  };

  /** Sends a dragged shape back to its tray slot. */
  private cancelDrag(): void {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    this.drawGhost();
    const piece = d.piece;
    const p = this.tray[d.slot];
    if (!p || piece.destroyed) return;
    const s = this.trayScale(p.shape);
    const [x0, y0, s0] = [piece.x, piece.y, piece.scale.x];
    this.top.removeChild(piece);
    this.trayLayer.addChild(piece);
    void tween(this.app, this.fast ? 0 : 160, (t) => {
      if (piece.destroyed) return;
      piece.position.set(x0 + (this.slotX(d.slot) - x0) * t, y0 + (this.trayY - y0) * t);
      piece.scale.set(s0 + (s - s0) * t);
    }).then(() => this.refreshFit());
  }

  // ---------------------------------------------------------------- effects

  private burst(x: number, y: number, color: number): void {
    if (this.fast) return;
    for (let i = 0; i < 5; i++) {
      const g = new Graphics().rect(-2.5, -2.5, 5, 5).fill(i % 2 ? 0xffffff : color);
      g.position.set(x, y);
      const a = Math.random() * Math.PI * 2;
      const v = 2 + Math.random() * 4;
      this.fx.addChild(g);
      this.particles.push({ g, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 2, life: 1 });
    }
  }

  private popup(text: string, x: number, y: number, fill: number, fontSize: number): void {
    const t = new Text({
      text,
      style: { fontSize, fill, fontWeight: "900", stroke: { color: 0x0b1020, width: 4 } },
    });
    t.anchor.set(0.5);
    t.position.set(x, y);
    this.top.addChild(t);
    void tween(this.app, this.fast ? 300 : 900, (k) => {
      if (t.destroyed) return;
      t.y = y - 40 * k;
      t.alpha = k < 0.6 ? 1 : 1 - (k - 0.6) / 0.4;
    }).then(() => t.destroy());
  }

  private readonly animate = () => {
    const dt = this.app.ticker.deltaTime;
    this.particles = this.particles.filter((p) => {
      p.life -= 0.03 * dt;
      if (p.life <= 0) {
        p.g.destroy();
        return false;
      }
      p.vy += 0.25 * dt;
      p.g.x += p.vx * dt;
      p.g.y += p.vy * dt;
      p.g.alpha = p.life;
      p.g.rotation += 0.2 * dt;
      return true;
    });
  };
}

function samePiece(a: GsPiece | null, b: GsPiece | null): boolean {
  return a === b || (a !== null && b !== null && a.shape === b.shape && a.color === b.color);
}

function popcount(n: number): number {
  let c = 0;
  for (let v = n; v; v &= v - 1) c++;
  return c;
}
