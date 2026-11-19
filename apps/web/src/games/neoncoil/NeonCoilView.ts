import { Application, Container, Graphics, Text } from "pixi.js";

import { createPixi, ease, lerp, prefersReducedMotion } from "../pixi";
import { mix, type Skin } from "./skins";
import { boardFor, type Cell, type Dir, GOLDEN_MS, MAX_COMBO, Snake, type StepEvent, tickMs, speedLevel } from "./snake";

const ARENA = 0x070b18;
const GRID_DOT = 0x1b2547;
const APPLE = 0xff3d7f;
const GOLD = 0xfacc15;
const FEVER = 0xff2fd6;
const TONGUE = 0xff4d6d;
/** Longest frame the loop will catch up on (a slow phone shouldn't teleport the snake). */
const MAX_FRAME_MS = 100;
const HIT_STOP_MS = 160;
const DISSOLVE_MS = 650;

export type Phase = "ready" | "running" | "paused" | "dying" | "over";

export interface Hud {
  score: number;
  length: number;
  speed: number;
  combo: number;
  /** Combo window left, 0-1. */
  comboLeft: number;
}

export interface RunStats {
  score: number;
  length: number;
  seconds: number;
  eaten: number;
  maxCombo: number;
}

export interface NeonCoilViewOptions {
  onHud: (hud: Hud) => void;
  onEvent: (event: StepEvent) => void;
  onOver: (stats: RunStats) => void;
}

interface Particle {
  g: Graphics;
  vx: number;
  vy: number;
  life: number;
  max: number;
}

interface Ring {
  g: Graphics;
  x: number;
  y: number;
  color: number;
  t: number;
  max: number;
}

interface Popup {
  t: Text;
  life: number;
}

/**
 * The arena, the snake and every effect, plus the game loop. The rules live in
 * `Snake`; this class decides when it steps and makes each step feel good:
 * smooth sub-cell movement, glow, bursts, popups, shake and hit-stop.
 */
export class NeonCoilView {
  private readonly board = new Container();
  private readonly arena = new Graphics();
  private readonly border = new Graphics();
  private readonly food = new Graphics();
  private readonly glow = new Graphics();
  private readonly body = new Graphics();
  private readonly fx = new Container();
  private readonly hud = new Container();
  private snake!: Snake;
  private prev: Cell[] = [];
  private acc = 0;
  private phase: Phase = "ready";
  private cell = 0;
  private ox = 0;
  private oy = 0;
  private clock = 0;
  private appleBorn = 0;
  private goldenBorn = 0;
  private maxCombo = 1;
  private shake = 0;
  private hitStop = 0;
  private dissolve = 0;
  private particles: Particle[] = [];
  private rings: Ring[] = [];
  private popups: Popup[] = [];
  private banner: Text | null = null;
  private bannerT = 0;
  private lastHud = "";
  private readonly fast = prefersReducedMotion();

  private constructor(
    private readonly app: Application,
    private skin: Skin,
    private readonly options: NeonCoilViewOptions,
  ) {
    // Layered additive halos instead of a blur filter: a blur costs several full-screen
    // passes a frame, which slow phones (and software rendering) can't keep up with.
    this.glow.blendMode = "add";
    this.fx.blendMode = "add";
    this.board.addChild(this.arena, this.border, this.food, this.glow, this.body, this.fx);
    app.stage.addChild(this.board, this.hud);
    app.ticker.add(this.animate);
    app.renderer.on("resize", this.layout);
    this.reset();
    this.layout();
  }

  static async create(host: HTMLElement, skin: Skin, options: NeonCoilViewOptions): Promise<NeonCoilView> {
    return new NeonCoilView(await createPixi(host), skin, options);
  }

  destroy(): void {
    this.app.ticker.remove(this.animate);
    this.app.renderer.off("resize", this.layout);
    this.app.destroy({ removeView: true }, { children: true });
  }

  get state(): Phase {
    return this.phase;
  }

  setSkin(skin: Skin): void {
    this.skin = skin;
    this.drawArena();
  }

  /** A fresh snake, waiting for the first input. */
  reset(): void {
    const { width, height } = this.app.screen;
    const { cols, rows } = boardFor(width, height);
    this.snake = new Snake(Math.random, cols, rows);
    this.prev = this.snake.body.map((c) => ({ ...c }));
    this.acc = 0;
    this.phase = "ready";
    this.maxCombo = 1;
    this.dissolve = 0;
    this.board.alpha = 1;
    this.appleBorn = this.clock;
    this.emitHud(true);
    if (this.cell) this.layout();
  }

  start(): void {
    if (this.phase === "ready" || this.phase === "paused") this.phase = "running";
  }

  pause(): void {
    if (this.phase === "running") this.phase = "paused";
  }

  /** Steers (and starts the run from the ready screen). */
  turn(dir: Dir): void {
    if (this.phase === "ready") this.start();
    if (this.phase !== "running") return;
    this.snake.turn(dir);
  }

  // ---------------------------------------------------------------- layout

  private readonly layout = () => {
    const { width, height } = this.app.screen;
    const pad = 6;
    const COLS = this.snake.cols;
    const ROWS = this.snake.rows;
    // A fresh board can take the new shape (a phone turned before the first move).
    if (this.phase === "ready" && this.snake.elapsed === 0 && this.cell) {
      const fit = boardFor(width, height);
      if (fit.cols !== COLS || fit.rows !== ROWS) {
        this.reset();
        return;
      }
    }
    this.cell = Math.max(4, Math.floor(Math.min((width - pad * 2) / COLS, (height - pad * 2) / ROWS)));
    this.ox = Math.round((width - this.cell * COLS) / 2);
    this.oy = Math.round((height - this.cell * ROWS) / 2);
    this.drawArena();
  };

  private drawArena(): void {
    const c = this.cell;
    const COLS = this.snake.cols;
    const ROWS = this.snake.rows;
    const w = c * COLS;
    const h = c * ROWS;
    const a = this.arena.clear();
    a.roundRect(this.ox, this.oy, w, h, c * 0.6).fill({ color: ARENA, alpha: 0.92 });
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        a.circle(this.px(x), this.py(y), Math.max(1, c * 0.06)).fill({ color: GRID_DOT });
      }
    }
  }

  private drawBorder(): void {
    const c = this.cell;
    const COLS = this.snake.cols;
    const ROWS = this.snake.rows;
    const fever = this.snake.combo >= MAX_COMBO && this.snake.comboLeft() > 0;
    const pulse = 0.5 + 0.5 * Math.sin(this.clock / (fever ? 90 : 600));
    const color = fever ? mix(this.skin.glow, FEVER, pulse) : this.skin.glow;
    const b = this.border.clear();
    const r = c * 0.6;
    b.roundRect(this.ox - 2, this.oy - 2, c * COLS + 4, c * ROWS + 4, r + 2).stroke({
      width: 6,
      color,
      alpha: 0.12 + 0.1 * pulse,
    });
    b.roundRect(this.ox, this.oy, c * COLS, c * ROWS, r).stroke({ width: 1.5, color, alpha: 0.55 + 0.3 * pulse });
  }

  private px(x: number): number {
    return this.ox + (x + 0.5) * this.cell;
  }

  private py(y: number): number {
    return this.oy + (y + 0.5) * this.cell;
  }

  // ---------------------------------------------------------------- loop

  private readonly animate = () => {
    const dt = Math.min(this.app.ticker.deltaMS, MAX_FRAME_MS);
    this.clock += dt;
    if (this.hitStop > 0) {
      this.hitStop -= dt;
    } else if (this.phase === "running") {
      this.acc += dt;
      let tick = tickMs(this.snake.elapsed);
      while (this.acc >= tick && this.phase === "running") {
        this.prev = this.snake.body.map((c) => ({ ...c }));
        const event = this.snake.step(tick);
        this.acc -= tick;
        this.handle(event);
        tick = tickMs(this.snake.elapsed);
      }
    } else if (this.phase === "dying") {
      this.dissolve += dt;
      if (this.dissolve >= DISSOLVE_MS) {
        this.phase = "over";
        this.options.onOver({
          score: this.snake.score,
          length: this.snake.body.length,
          seconds: Math.round(this.snake.elapsed / 1000),
          eaten: this.snake.eaten,
          maxCombo: this.maxCombo,
        });
      }
    }
    const frac = this.phase === "running" ? Math.min(1, this.acc / tickMs(this.snake.elapsed)) : 1;
    this.drawBorder();
    this.drawFood();
    this.drawSnake(frac);
    this.updateFx(dt);
    if (this.phase === "running") this.emitHud(false);
  };

  private handle(event: StepEvent): void {
    this.options.onEvent(event);
    const s = this.snake;
    if (event.ate) {
      const { food, points, combo } = event.ate;
      this.maxCombo = Math.max(this.maxCombo, combo);
      const x = this.px(food.x);
      const y = this.py(food.y);
      const color = food.golden ? GOLD : combo >= MAX_COMBO ? FEVER : APPLE;
      this.burst(x, y, food.golden ? [GOLD, 0xfff7ae, 0xffffff] : [color, this.skin.head, 0xffffff], food.golden ? 26 : 14);
      this.ring(x, y, color, food.golden ? 3.2 : 2.2);
      this.popup(x, y, combo > 1 ? `+${points} ×${combo}` : `+${points}`, color, food.golden || combo >= 3);
      if (!food.golden) this.appleBorn = this.clock;
      if (s.golden) this.goldenBorn = this.clock;
      this.emitHud(true);
    }
    if (event.goldenGone) {
      this.burst(this.px(event.goldenGone.x), this.py(event.goldenGone.y), [0x6b7280, GOLD], 8);
    }
    if (event.speedUp) this.showBanner(`SPEED ${event.speedUp}`);
    if (event.died) {
      this.phase = "dying";
      this.hitStop = this.fast ? 0 : HIT_STOP_MS;
      this.shake = this.fast ? 0 : 420;
      this.dissolve = 0;
      this.prev = this.snake.body.map((c) => ({ ...c }));
      const head = s.body[0] ?? { x: 0, y: 0 };
      this.ring(this.px(head.x), this.py(head.y), 0xff3b3b, 4);
      this.emitHud(true);
    }
  }

  private emitHud(force: boolean): void {
    const s = this.snake;
    const hud: Hud = {
      score: s.score,
      length: s.body.length,
      speed: speedLevel(s.elapsed),
      combo: s.comboLeft() > 0 ? s.combo : 1,
      comboLeft: s.comboLeft(),
    };
    // React only hears about changes (the combo bar drains in steps of 5%).
    const key = `${hud.score}|${hud.length}|${hud.speed}|${hud.combo}|${Math.ceil(hud.comboLeft * 20)}`;
    if (!force && key === this.lastHud) return;
    this.lastHud = key;
    this.options.onHud(hud);
  }

  // ---------------------------------------------------------------- drawing

  private drawFood(): void {
    const c = this.cell;
    const f = this.food.clear();
    const s = this.snake;
    const t = this.clock;
    // The apple: a pulsing neon orb with a halo and a leaf, popping in when it appears.
    const born = this.fast ? 1 : ease.outBack(Math.min(1, (t - this.appleBorn) / 260));
    const pulse = 1 + 0.08 * Math.sin(t / 160);
    const ax = this.px(s.apple.x);
    const ay = this.py(s.apple.y);
    const r = c * 0.34 * pulse * born;
    f.circle(ax, ay, r * 2.1).fill({ color: APPLE, alpha: 0.08 });
    f.circle(ax, ay, r * 1.5).fill({ color: APPLE, alpha: 0.16 });
    f.circle(ax, ay, r).fill({ color: APPLE });
    f.circle(ax - r * 0.32, ay - r * 0.32, r * 0.3).fill({ color: 0xffffff, alpha: 0.75 });
    f.ellipse(ax + r * 0.35, ay - r * 1.05, r * 0.38, r * 0.18).fill({ color: 0x4ade80 });

    const g = s.golden;
    if (g) {
      const left = Math.max(0, ((g.expires ?? 0) - s.elapsed) / GOLDEN_MS);
      // Blinks in its last 2 seconds.
      if (left < 0.3 && Math.floor(t / 110) % 2 === 0) return;
      const gb = this.fast ? 1 : ease.outBack(Math.min(1, (t - this.goldenBorn) / 320));
      const gx = this.px(g.x);
      const gy = this.py(g.y);
      const gr = c * 0.46 * gb;
      f.circle(gx, gy, gr * 1.9).fill({ color: GOLD, alpha: 0.12 });
      f.star(gx, gy, 5, gr, gr * 0.48, t / 500).fill({ color: GOLD });
      f.star(gx, gy, 5, gr * 0.45, gr * 0.22, t / 500).fill({ color: 0xfff7ae });
      // How long it stays: a ring that runs down.
      const start = -Math.PI / 2;
      f.arc(gx, gy, gr * 1.35, start, start + Math.PI * 2 * left).stroke({ width: 2, color: GOLD, alpha: 0.9, cap: "round" });
    }
  }

  /** Where each segment is drawn: between its last cell and its new one. */
  private positions(frac: number): [number, number][] {
    const body = this.snake.body;
    const last = this.prev[this.prev.length - 1] ?? body[body.length - 1] ?? { x: 0, y: 0 };
    return body.map((cur, i) => {
      const from = this.prev[i] ?? last;
      return [this.px(lerp(from.x, cur.x, frac)), this.py(lerp(from.y, cur.y, frac))];
    });
  }

  private drawSnake(frac: number): void {
    const c = this.cell;
    const g = this.glow.clear();
    const b = this.body.clear();
    const pts = this.positions(frac);
    const n = pts.length;
    const dying = this.phase === "dying" || this.phase === "over";
    // While dying the snake comes apart from the head down to the tail.
    const gone = dying ? Math.floor((this.dissolve / DISSOLVE_MS) * (n + 1)) : 0;
    const flash = dying && this.hitStop > 0;

    // Dense samples along the body, drawn tail first so the head sits on top.
    const SUB = 4;
    for (let i = n - 1; i >= gone; i--) {
      const p = pts[i];
      if (!p) continue;
      const q = pts[i + 1];
      const steps = q && i + 1 >= gone ? SUB : 1;
      for (let k = steps - 1; k >= 0; k--) {
        const u = k / SUB;
        const x = q ? lerp(p[0], q[0], u) : p[0];
        const y = q ? lerp(p[1], q[1], u) : p[1];
        const along = (i + u) / Math.max(1, n - 1);
        const r = c * (0.44 - 0.2 * along);
        const color = flash ? 0xffffff : dying ? mix(mix(this.skin.head, this.skin.tail, along), 0xff3b3b, 0.55) : mix(this.skin.head, this.skin.tail, along);
        if (k === 0) {
          const halo = flash ? 0xff3b3b : this.skin.glow;
          g.circle(x, y, r * 2.1).fill({ color: halo, alpha: 0.07 });
          g.circle(x, y, r * 1.5).fill({ color: halo, alpha: 0.14 });
        }
        b.circle(x, y, r).fill({ color });
      }
      // A soft highlight down the middle of the body.
      b.circle(p[0], p[1], c * (0.13 - 0.07 * (i / Math.max(1, n - 1)))).fill({ color: 0xffffff, alpha: 0.18 });
    }
    if (dying && gone > 0 && gone <= n && this.particles.length < 260) {
      const p = pts[gone - 1];
      if (p) this.burst(p[0], p[1], [this.skin.head, this.skin.glow, 0xff3b3b], this.fast ? 2 : 4);
    }
    if (gone > 0) return;

    // Head: eyes that follow the food, and a tongue that flicks now and then.
    const head = pts[0];
    if (!head) return;
    const neck = pts[1] ?? [head[0], head[1] + 1];
    let dx = head[0] - neck[0];
    let dy = head[1] - neck[1];
    const len = Math.hypot(dx, dy);
    if (len < 0.001) {
      const d = this.snake.dir;
      dx = d === "left" ? -1 : d === "right" ? 1 : 0;
      dy = d === "up" ? -1 : d === "down" ? 1 : 0;
    } else {
      dx /= len;
      dy /= len;
    }
    const nx = -dy;
    const ny = dx;
    const target = this.snake.golden ?? this.snake.apple;
    let lx = this.px(target.x) - head[0];
    let ly = this.py(target.y) - head[1];
    const tl = Math.hypot(lx, ly) || 1;
    lx /= tl;
    ly /= tl;
    if (!dying && !this.fast && this.clock % 2200 < 200) {
      const tx = head[0] + dx * c * 0.42;
      const ty = head[1] + dy * c * 0.42;
      const reach = c * 0.34 * Math.sin(((this.clock % 2200) / 200) * Math.PI);
      const ex = tx + dx * reach;
      const ey = ty + dy * reach;
      b.moveTo(tx, ty).lineTo(ex, ey).stroke({ width: Math.max(1.5, c * 0.07), color: TONGUE, cap: "round" });
      for (const side of [-1, 1]) {
        b.moveTo(ex, ey)
          .lineTo(ex + (dx + nx * side) * c * 0.1, ey + (dy + ny * side) * c * 0.1)
          .stroke({ width: Math.max(1.2, c * 0.05), color: TONGUE, cap: "round" });
      }
    }
    for (const side of [-1, 1]) {
      const ex = head[0] + nx * side * c * 0.19 + dx * c * 0.08;
      const ey = head[1] + ny * side * c * 0.19 + dy * c * 0.08;
      const er = c * 0.12;
      b.circle(ex, ey, er).fill({ color: 0xffffff });
      if (dying) {
        const k = er * 0.6;
        b.moveTo(ex - k, ey - k).lineTo(ex + k, ey + k).moveTo(ex + k, ey - k).lineTo(ex - k, ey + k).stroke({ width: 1.5, color: 0x0b1020 });
      } else {
        b.circle(ex + lx * er * 0.4, ey + ly * er * 0.4, er * 0.55).fill({ color: 0x0b1020 });
      }
    }
  }

  // ---------------------------------------------------------------- effects

  private burst(x: number, y: number, colors: number[], count: number): void {
    const n = this.fast ? Math.ceil(count / 3) : count;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const speed = (0.6 + Math.random() * 2.2) * Math.max(1, this.cell / 18);
      const g = new Graphics()
        .circle(0, 0, Math.max(1.2, this.cell * (0.05 + Math.random() * 0.07)))
        .fill({ color: colors[i % colors.length] ?? 0xffffff });
      g.position.set(x, y);
      this.fx.addChild(g);
      const life = 380 + Math.random() * 380;
      this.particles.push({ g, vx: Math.cos(a) * speed, vy: Math.sin(a) * speed, life, max: life });
    }
  }

  private ring(x: number, y: number, color: number, cells: number): void {
    if (this.fast) return;
    const g = new Graphics();
    this.fx.addChild(g);
    this.rings.push({ g, x, y, color, t: 0, max: cells });
  }

  private popup(x: number, y: number, text: string, color: number, big: boolean): void {
    const t = new Text({
      text,
      style: {
        fontFamily: "ui-rounded, system-ui, sans-serif",
        fontWeight: "800",
        fontSize: Math.max(12, this.cell * (big ? 0.85 : 0.6)),
        fill: color,
        stroke: { color: 0x0b1020, width: 3 },
      },
    });
    t.anchor.set(0.5);
    t.position.set(x, y - this.cell * 0.6);
    this.hud.addChild(t);
    this.popups.push({ t, life: 0 });
  }

  private showBanner(text: string): void {
    this.banner?.destroy();
    const t = new Text({
      text,
      style: {
        fontFamily: "ui-rounded, system-ui, sans-serif",
        fontWeight: "900",
        fontSize: Math.max(22, this.cell * 1.6),
        fill: 0xffffff,
        letterSpacing: 4,
        stroke: { color: this.skin.glow, width: 4 },
        dropShadow: { color: this.skin.glow, blur: 12, distance: 0, alpha: 0.9 },
      },
    });
    t.anchor.set(0.5);
    t.position.set(this.app.screen.width / 2, this.oy + this.cell * this.snake.rows * 0.32);
    this.hud.addChild(t);
    this.banner = t;
    this.bannerT = 0;
  }

  private updateFx(dt: number): void {
    const k = dt / 16.67;
    this.particles = this.particles.filter((p) => {
      p.life -= dt;
      if (p.life <= 0) {
        p.g.destroy();
        return false;
      }
      p.g.x += p.vx * k;
      p.g.y += p.vy * k;
      p.vx *= Math.pow(0.94, k);
      p.vy *= Math.pow(0.94, k);
      p.g.alpha = p.life / p.max;
      return true;
    });
    this.rings = this.rings.filter((r) => {
      r.t += dt / 450;
      if (r.t >= 1) {
        r.g.destroy();
        return false;
      }
      const e = ease.outCubic(r.t);
      r.g.clear().circle(r.x, r.y, this.cell * r.max * e).stroke({ width: Math.max(1, 4 * (1 - e)), color: r.color, alpha: 1 - e });
      return true;
    });
    this.popups = this.popups.filter((p) => {
      p.life += dt;
      if (p.life >= 800) {
        p.t.destroy();
        return false;
      }
      const u = p.life / 800;
      p.t.y -= 0.6 * k;
      p.t.alpha = u < 0.6 ? 1 : 1 - (u - 0.6) / 0.4;
      p.t.scale.set(this.fast ? 1 : 0.6 + 0.4 * ease.outBack(Math.min(1, u * 4)));
      return true;
    });
    if (this.banner) {
      this.bannerT += dt;
      const u = this.bannerT / 1100;
      if (u >= 1) {
        this.banner.destroy();
        this.banner = null;
      } else {
        this.banner.alpha = u < 0.7 ? 1 : 1 - (u - 0.7) / 0.3;
        this.banner.scale.set(this.fast ? 1 : 0.5 + 0.5 * ease.outBack(Math.min(1, u * 4)));
      }
    }
    if (this.shake > 0 && this.hitStop <= 0) {
      this.shake -= dt;
      const m = Math.max(0, this.shake / 420) * this.cell * 0.35;
      this.board.position.set((Math.random() - 0.5) * m, (Math.random() - 0.5) * m);
    } else if (this.shake <= 0) {
      this.board.position.set(0, 0);
    }
  }
}
