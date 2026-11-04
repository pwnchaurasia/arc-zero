import { Application, Container, type FederatedPointerEvent, Graphics, Text } from "pixi.js";

import type { ToLevelData } from "../../api/types";
import { createPixi, prefersReducedMotion, tween } from "../pixi";

const PAPER = 0xfcf8f2;
const PAPER_EDGE = 0xe9dcc6;
const DOT = 0xe2d3bb;
/** The picture's outline: a faint tint under its lines, so the shape reads even as they leave. */
const PICTURE = 0xf2e6d2;
const INK = 0x3d2616;
const BLOCKED = 0xdc2626;
const HINT = 0xd97706;
/** Sparkles where a line leaves the board. */
const SPARKS = [0xfbbf24, 0xf59e0b, 0x84cc16, 0x38bdf8, 0xf472b6];
/** Zooming in stops once a cell is this many pixels across. */
const MAX_CELL_PX = 40;
/** A press that moves further than this (px) is a drag, not a tap. */
const TAP_SLOP = 9;
const DOUBLE_TAP_MS = 320;

export interface TraceOutViewOptions {
  onTap: (line: number) => void;
}

type Pt = [number, number];

/**
 * The paper board and its lines. Purely visual: the controller owns the rules
 * (WASM engine) and tells the view which line left or bounced.
 */
export class TraceOutView {
  /** Everything that zooms and pans: the paper, the lines and their effects. */
  private readonly board = new Container();
  private readonly paper = new Graphics();
  private readonly layer = new Container();
  private readonly fx = new Container();
  /** Screen-fixed overlay (streak cheers), unaffected by zoom. */
  private readonly hud = new Container();
  /** Fingers (or the mouse) currently down, by pointer id, in screen pixels. */
  private pointers = new Map<number, Pt>();
  /** A single press that may become a tap or a pan. */
  private press: { x: number; y: number; from: Pt; moved: boolean } | null = null;
  /** A two-finger pinch: where it started and the board's scale and position then. */
  private pinch: { dist: number; mid: Pt; scale: number; at: Pt } | null = null;
  private lastTap = 0;
  private particles: { g: Graphics; vx: number; vy: number; life: number; fall: number }[] = [];
  private lines: (Graphics | null)[] = [];
  private present: boolean[];
  private cell = 0;
  private ox = 0;
  private oy = 0;
  private busy = new Set<number>();
  private destroyed = false;
  private readonly fast = prefersReducedMotion();

  private constructor(
    private readonly app: Application,
    private readonly level: ToLevelData,
    private readonly options: TraceOutViewOptions,
  ) {
    this.present = level.lines.map(() => true);
    this.board.addChild(this.paper, this.layer, this.fx);
    app.stage.addChild(this.board, this.hud);
    app.ticker.add(this.animate);
    app.stage.eventMode = "static";
    app.stage.hitArea = app.screen;
    app.stage.on("pointerdown", this.onDown);
    app.stage.on("pointermove", this.onMove);
    app.stage.on("pointerup", this.onUp);
    app.stage.on("pointerupoutside", this.onUp);
    app.canvas.addEventListener("wheel", this.onWheel, { passive: false });
    app.renderer.on("resize", this.layout);
    this.layout();
  }

  static async create(host: HTMLElement, level: ToLevelData, options: TraceOutViewOptions): Promise<TraceOutView> {
    return new TraceOutView(await createPixi(host), level, options);
  }

  destroy(): void {
    this.destroyed = true;
    this.app.canvas.removeEventListener("wheel", this.onWheel);
    this.app.ticker.remove(this.animate);
    this.app.renderer.off("resize", this.layout);
    this.app.destroy({ removeView: true }, { children: true });
  }

  /** Shows exactly the lines still on the board (after a restart). */
  sync(present: boolean[]): void {
    this.present = present.slice();
    this.busy.clear();
    this.drawLines();
  }

  /** The line slides along its own path and off the board. */
  async exit(i: number): Promise<void> {
    this.present[i] = false;
    const g = this.lines[i];
    const line = this.level.lines[i];
    if (!g || !line) return;
    this.busy.add(i);
    const path = this.exitPath(i);
    const len = line.cells.length - 1;
    const travel = path.length - 1 - len;
    // Where the arrow crosses the paper's edge: a burst of sparkles when it gets there.
    const edge = this.edgeOf(i);
    let sparkled = false;
    await tween(this.app, this.fast ? 0 : Math.min(700, 220 + travel * 22), (t) => {
      if (g.destroyed) return;
      g.clear();
      const part = slice(path, t * travel, t * travel + len);
      // A soft golden trail behind the moving line.
      this.stroke(g, part, 0xfbbf24, 0.25 * (1 - t), 2.2);
      this.stroke(g, part, INK, 1);
      g.alpha = t < 0.8 ? 1 : 1 - (t - 0.8) / 0.2;
      const head = part[part.length - 1];
      if (!sparkled && head && Math.hypot(head[0] - edge[0], head[1] - edge[1]) < this.cell * 0.6) {
        sparkled = true;
        this.burst(edge[0], edge[1], SPARKS, 12);
      }
    });
    if (!sparkled) this.burst(edge[0], edge[1], SPARKS, 12);
    this.busy.delete(i);
    if (!g.destroyed) g.visible = false;
  }

  /** A blocked tap: the line lunges towards the blocker and snaps back, both flash red. */
  async bump(i: number, by: number): Promise<void> {
    const g = this.lines[i];
    const other = this.lines[by];
    const line = this.level.lines[i];
    if (!g || !line || this.busy.has(i)) return;
    this.busy.add(i);
    const [dx, dy] = dirOf(line.cells);
    other?.clear();
    if (other) this.stroke(other, this.centres(by), BLOCKED, 1);
    const pts = this.centres(i);
    const [hx, hy] = pts[pts.length - 1] ?? [0, 0];
    this.burst(hx + dx * this.cell * 0.5, hy + dy * this.cell * 0.5, [BLOCKED, 0xfca5a5], 8);
    await tween(this.app, this.fast ? 0 : 320, (t) => {
      if (g.destroyed) return;
      const k = Math.sin(t * Math.PI) * this.cell * 0.35;
      g.clear();
      this.stroke(g, pts.map(([x, y]) => [x + dx * k, y + dy * k] as Pt), BLOCKED, 1);
      // The whole board shudders.
      const shake = this.fast ? 0 : Math.sin(t * Math.PI * 8) * (1 - t) * 4;
      this.layer.x = this.paper.x = shake;
    });
    this.layer.x = this.paper.x = 0;
    this.busy.delete(i);
    if (!this.destroyed) this.drawLines();
  }

  /** Hint: the line glows for a moment. */
  async glow(i: number): Promise<void> {
    const g = this.lines[i];
    if (!g) return;
    await tween(this.app, this.fast ? 600 : 2000, (t) => {
      if (g.destroyed || !this.present[i]) return;
      g.clear();
      const on = Math.sin(t * Math.PI * 6) > -0.2;
      this.stroke(g, this.centres(i), on ? HINT : INK, 1);
    });
    if (!this.destroyed && this.present[i]) this.drawLines();
  }

  /** Praise for a streak of clean taps, floating up from the top of the paper. */
  cheer(text: string, color: number): void {
    const t = new Text({
      text,
      style: { fontSize: 30, fill: color, fontWeight: "900", stroke: { color: 0xffffff, width: 5 } },
    });
    t.anchor.set(0.5);
    const x = this.app.screen.width / 2;
    const y = Math.max(40, this.board.y + (this.oy + this.cell * 1.5) * this.board.scale.y);
    t.position.set(x, y);
    this.hud.addChild(t);
    void tween(this.app, this.fast ? 400 : 1000, (k) => {
      if (t.destroyed) return;
      t.y = y - 36 * k;
      t.scale.set(k < 0.15 ? 0.6 + (k / 0.15) * 0.5 : 1.1 - Math.min(0.1, (k - 0.15) * 0.4));
      t.alpha = k < 0.7 ? 1 : 1 - (k - 0.7) / 0.3;
    }).then(() => t.destroy());
  }

  /** Level clear: confetti over the paper. */
  async celebrate(): Promise<void> {
    if (this.fast) return;
    const w = this.cell * this.level.width;
    const h = this.cell * this.level.height;
    for (let wave = 0; wave < 4 && !this.destroyed; wave++) {
      for (let k = 0; k < 5; k++) {
        this.burst(this.ox + Math.random() * w, this.oy + Math.random() * h * 0.7, SPARKS, 10);
      }
      await tween(this.app, 160, () => undefined);
    }
  }

  // ---------------------------------------------------------------- effects

  private burst(x: number, y: number, colors: number[], n: number): void {
    if (this.fast || this.destroyed) return;
    const size = Math.max(3, this.cell * 0.14);
    for (let k = 0; k < n; k++) {
      const color = colors[k % colors.length] ?? 0xffffff;
      const g = new Graphics();
      if (k % 3 === 0) g.circle(0, 0, size * 0.55).fill(color);
      else g.rect(-size / 2, -size / 4, size, size / 2).fill(color);
      g.position.set(x, y);
      const a = Math.random() * Math.PI * 2;
      const v = 1.5 + Math.random() * 3.5;
      this.fx.addChild(g);
      this.particles.push({ g, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 1.5, life: 1, fall: 0.12 });
    }
  }

  private readonly animate = () => {
    const dt = this.app.ticker.deltaTime;
    this.particles = this.particles.filter((p) => {
      p.life -= 0.025 * dt;
      if (p.life <= 0 || p.g.destroyed) {
        p.g.destroy();
        return false;
      }
      p.vy += p.fall * dt;
      p.g.x += p.vx * dt;
      p.g.y += p.vy * dt;
      p.g.alpha = Math.min(1, p.life * 1.5);
      p.g.rotation += 0.15 * dt;
      return true;
    });
  };

  // ---------------------------------------------------------------- layout

  private readonly layout = () => {
    const { width: W, height: H } = this.app.screen;
    this.fit();
    const pad = 14;
    // The paper adds 0.4 of a cell around the grid.
    this.cell = Math.floor(
      Math.min((W - 2 * pad) / (this.level.width + 0.8), (H - 2 * pad) / (this.level.height + 0.8)),
    );
    this.ox = Math.round((W - this.cell * this.level.width) / 2);
    this.oy = Math.round((H - this.cell * this.level.height) / 2);
    const g = this.paper.clear();
    const m = this.cell * 0.4;
    g.roundRect(this.ox - m, this.oy - m, this.cell * this.level.width + 2 * m, this.cell * this.level.height + 2 * m, 22)
      .fill(PAPER)
      .stroke({ width: 2, color: PAPER_EDGE });
    if (this.level.theme) {
      for (const line of this.level.lines) {
        for (const [x, y] of line.cells) {
          g.rect(this.ox + x * this.cell, this.oy + y * this.cell, this.cell + 0.5, this.cell + 0.5).fill(PICTURE);
        }
      }
    }
    for (let y = 0; y < this.level.height; y++) {
      for (let x = 0; x < this.level.width; x++) {
        g.circle(this.ox + (x + 0.5) * this.cell, this.oy + (y + 0.5) * this.cell, Math.max(1, this.cell * 0.05)).fill(DOT);
      }
    }
    this.drawLines();
  };

  private drawLines(): void {
    this.lines.forEach((g) => g?.destroy());
    this.lines = this.level.lines.map((_, i) => {
      if (!this.present[i]) return null;
      const g = new Graphics();
      this.stroke(g, this.centres(i), INK, 1);
      this.layer.addChild(g);
      return g;
    });
  }

  private centres(i: number): Pt[] {
    return (this.level.lines[i]?.cells ?? []).map(([x, y]) => [this.ox + (x + 0.5) * this.cell, this.oy + (y + 0.5) * this.cell]);
  }

  /** The line's own path, then straight on past the board edge far enough for the whole line to leave. */
  private exitPath(i: number): Pt[] {
    const line = this.level.lines[i];
    const pts = this.centres(i);
    if (!line) return pts;
    const [dx, dy] = dirOf(line.cells);
    const [hx, hy] = pts[pts.length - 1] ?? [0, 0];
    const steps = Math.max(this.level.width, this.level.height) + line.cells.length + 2;
    for (let k = 1; k <= steps; k++) pts.push([hx + dx * k * this.cell, hy + dy * k * this.cell]);
    return pts;
  }

  /** Where line `i` crosses the paper's edge on its way out. */
  private edgeOf(i: number): Pt {
    const line = this.level.lines[i];
    const pts = this.centres(i);
    const [hx, hy] = pts[pts.length - 1] ?? [0, 0];
    if (!line) return [hx, hy];
    const [dx, dy] = dirOf(line.cells);
    const m = this.cell * 0.4;
    const x = dx > 0 ? this.ox + this.cell * this.level.width + m : dx < 0 ? this.ox - m : hx;
    const y = dy > 0 ? this.oy + this.cell * this.level.height + m : dy < 0 ? this.oy - m : hy;
    return [x, y];
  }

  /** A thick rounded polyline with an arrowhead at its end (`widen` for glows). */
  private stroke(g: Graphics, pts: Pt[], color: number, alpha: number, widen = 1): void {
    if (pts.length < 2) return;
    const w = Math.max(3, this.cell * 0.22) * widen;
    const [x0, y0] = pts[0] ?? [0, 0];
    g.moveTo(x0, y0);
    for (const [x, y] of pts.slice(1)) g.lineTo(x, y);
    g.stroke({ width: w, color, alpha, cap: "round", join: "round" });
    const [hx, hy] = pts[pts.length - 1] ?? [0, 0];
    const [px, py] = pts[pts.length - 2] ?? [0, 0];
    const len = Math.hypot(hx - px, hy - py) || 1;
    const ux = (hx - px) / len;
    const uy = (hy - py) / len;
    const tip = this.cell * 0.32;
    const half = this.cell * 0.26;
    g.poly([hx + ux * tip, hy + uy * tip, hx - uy * half, hy + ux * half, hx + uy * half, hy - ux * half]).fill({ color, alpha });
  }

  // ------------------------------------------------------------------ input

  /** Whether the board is zoomed in (tutorial hints and tests can check this). */
  get zoomed(): boolean {
    return this.board.scale.x > 1.01;
  }

  /** Back to the whole board on screen. */
  fit(): void {
    this.board.scale.set(1);
    this.board.position.set(0, 0);
  }

  private maxZoom(): number {
    return Math.max(1, MAX_CELL_PX / Math.max(1, this.cell));
  }

  /** Zooms to `scale` keeping the board point under screen point `at` where it is. */
  private zoomAt(at: Pt, scale: number, from = { scale: this.board.scale.x, pos: [this.board.x, this.board.y] as Pt }): void {
    const s = Math.min(this.maxZoom(), Math.max(1, scale));
    const bx = (at[0] - from.pos[0]) / from.scale;
    const by = (at[1] - from.pos[1]) / from.scale;
    this.board.scale.set(s);
    this.board.position.set(at[0] - bx * s, at[1] - by * s);
    this.clampPan();
  }

  /** Keeps the zoomed board covering the screen: no panning off into empty space. */
  private clampPan(): void {
    const { width: W, height: H } = this.app.screen;
    const s = this.board.scale.x;
    this.board.x = Math.min(0, Math.max(W - W * s, this.board.x));
    this.board.y = Math.min(0, Math.max(H - H * s, this.board.y));
  }

  private readonly onDown = (e: FederatedPointerEvent) => {
    this.pointers.set(e.pointerId, [e.global.x, e.global.y]);
    if (this.pointers.size === 1) {
      this.press = { x: e.global.x, y: e.global.y, from: [this.board.x, this.board.y], moved: false };
    } else if (this.pointers.size === 2) {
      // Two fingers: a pinch, never a tap.
      this.press = null;
      const [a, b] = [...this.pointers.values()] as [Pt, Pt];
      this.pinch = {
        dist: Math.hypot(a[0] - b[0], a[1] - b[1]) || 1,
        mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2],
        scale: this.board.scale.x,
        at: [this.board.x, this.board.y],
      };
    }
  };

  private readonly onMove = (e: FederatedPointerEvent) => {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.set(e.pointerId, [e.global.x, e.global.y]);
    if (this.pinch && this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()] as [Pt, Pt];
      const dist = Math.hypot(a[0] - b[0], a[1] - b[1]) || 1;
      const mid: Pt = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      // Zoom about where the pinch started, then follow the fingers' midpoint.
      this.zoomAt(this.pinch.mid, (this.pinch.scale * dist) / this.pinch.dist, { scale: this.pinch.scale, pos: this.pinch.at });
      this.board.x += mid[0] - this.pinch.mid[0];
      this.board.y += mid[1] - this.pinch.mid[1];
      this.clampPan();
      return;
    }
    const p = this.press;
    if (!p) return;
    const dx = e.global.x - p.x;
    const dy = e.global.y - p.y;
    if (!p.moved && Math.hypot(dx, dy) > TAP_SLOP) p.moved = true;
    if (p.moved && this.zoomed) {
      this.board.position.set(p.from[0] + dx, p.from[1] + dy);
      this.clampPan();
    }
  };

  private readonly onUp = (e: FederatedPointerEvent) => {
    const p = this.press;
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinch = null;
    if (this.pointers.size > 0) {
      // Lifting one finger of a pinch: the other one shouldn't tap or jump.
      this.press = null;
      return;
    }
    this.press = null;
    if (!p || p.moved) return;
    const line = this.lineAt(e.global.x, e.global.y);
    if (line >= 0) {
      this.lastTap = 0;
      this.options.onTap(line);
      return;
    }
    // Double-tap on the paper: back to the whole board.
    const now = performance.now();
    if (now - this.lastTap < DOUBLE_TAP_MS) {
      this.fit();
      this.lastTap = 0;
    } else {
      this.lastTap = now;
    }
  };

  private readonly onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const rect = this.app.canvas.getBoundingClientRect();
    const at: Pt = [e.clientX - rect.left, e.clientY - rect.top];
    this.zoomAt(at, this.board.scale.x * Math.exp(-e.deltaY * 0.0015));
  };

  /** The line nearest a screen point, within 0.6 of a cell; -1 if none. */
  private lineAt(sx: number, sy: number): number {
    const { x, y } = this.board.toLocal({ x: sx, y: sy });
    let best = -1;
    let bestD = this.cell * 0.6;
    this.level.lines.forEach((_, i) => {
      if (!this.present[i] || this.busy.has(i)) return;
      const pts = this.centres(i);
      for (let k = 0; k + 1 < pts.length; k++) {
        const d = distToSegment(x, y, pts[k] ?? [0, 0], pts[k + 1] ?? [0, 0]);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
    });
    return best;
  }
}

function dirOf(cells: [number, number][]): Pt {
  const [hx, hy] = cells[cells.length - 1] ?? [0, 0];
  const [px, py] = cells[cells.length - 2] ?? [0, 0];
  return [hx - px, hy - py];
}

function distToSegment(x: number, y: number, [ax, ay]: Pt, [bx, by]: Pt): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2));
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
}

/** The part of a polyline between distances `from` and `to` (in segments; every segment is one cell). */
function slice(pts: Pt[], from: number, to: number): Pt[] {
  const at = (s: number): Pt => {
    const k = Math.min(Math.floor(s), pts.length - 2);
    const f = s - k;
    const [ax, ay] = pts[k] ?? [0, 0];
    const [bx, by] = pts[k + 1] ?? [0, 0];
    return [ax + (bx - ax) * f, ay + (by - ay) * f];
  };
  const out: Pt[] = [at(from)];
  for (let k = Math.ceil(from); k < to; k++) if (k > from) out.push(pts[k] ?? [0, 0]);
  out.push(at(to));
  return out;
}
