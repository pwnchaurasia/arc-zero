import { Application, Container, Graphics, Sprite, Text, Texture } from "pixi.js";

import { createPixi, ease, lerp, prefersReducedMotion } from "../pixi";
import { fruitGoal, levelTick, levelWalls, speedStep } from "./levels";
import { mix, type Skin } from "./skins";
import { boardFor, type Cell, type Dir, Snake, type StepEvent } from "./snake";

const ARENA = 0x070b18;
const GRID_DOT = 0x1b2547;
const WALL = 0x2e1065;
const WALL_EDGE = 0xa78bfa;
const APPLE = 0xff3d7f;
/** Longest frame the loop will catch up on (a slow phone shouldn't teleport the snake). */
const MAX_FRAME_MS = 100;
const HIT_STOP_MS = 140;
/** How long the crash and the clear celebration play before the card shows. */
const DISSOLVE_MS = 1000;
const CLEAR_MS = 1900;
/** A turn pressed within this part of a step still takes the cell just left. */
const LATE_TURN = 0.45;
/** Body samples per cell: enough to look like one smooth tube. */
const SAMPLES_PER_CELL = 6;

export type Phase = "ready" | "running" | "paused" | "ending" | "done";

export interface LevelResult {
  level: number;
  cleared: boolean;
  stars: number;
  moves: number;
  par: number;
}

export interface NeonCoilViewOptions {
  onEat: (eaten: number, goal: number, speed: number) => void;
  onStep: (event: StepEvent) => void;
  onEnd: (result: LevelResult) => void;
}

type Pt = [number, number];

/** A soft-shaded disc: white in the middle, a little darker at the rim, so a tint looks like a tube. */
function discTexture(): Texture {
  const size = 64;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d");
  if (g) {
    const grad = g.createRadialGradient(size * 0.4, size * 0.38, 2, size / 2, size / 2, size / 2);
    grad.addColorStop(0, "#ffffff");
    grad.addColorStop(0.7, "#e6e6e6");
    grad.addColorStop(1, "#a8a8a8");
    g.fillStyle = grad;
    g.beginPath();
    g.arc(size / 2, size / 2, size / 2 - 1, 0, Math.PI * 2);
    g.fill();
  }
  return Texture.from(c);
}

/** A glow: white fading to transparent. */
function haloTexture(): Texture {
  const size = 128;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d");
  if (g) {
    const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0, "rgba(255,255,255,0.9)");
    grad.addColorStop(0.35, "rgba(255,255,255,0.35)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
  }
  return Texture.from(c);
}

interface Particle {
  s: Sprite;
  vx: number;
  vy: number;
  life: number;
  max: number;
}

/**
 * The arena, the snake and its effects, plus the game loop. The rules live in
 * `Snake`; this class decides when it steps and draws it. The body is a row of
 * sprites laid along the snake's path through the cell centres, so it glides and
 * bends smoothly, and nothing has to be re-tessellated each frame.
 */
export class NeonCoilView {
  private readonly board = new Container();
  private readonly arena = new Graphics();
  private readonly border = new Graphics();
  private readonly fruitHalo: Sprite;
  private readonly fruit = new Graphics();
  private readonly glowLayer = new Container();
  private readonly bodyLayer = new Container();
  private readonly face = new Graphics();
  private readonly fx = new Container();
  private readonly hud = new Container();
  private readonly disc = discTexture();
  private readonly halo = haloTexture();
  private bodySprites: Sprite[] = [];
  private glowSprites: Sprite[] = [];
  private snake!: Snake;
  private level = 1;
  private tick = levelTick(1);
  private prev: Cell[] = [];
  private acc = 0;
  private phase: Phase = "ready";
  private cell = 0;
  private ox = 0;
  private oy = 0;
  private clock = 0;
  private fruitBorn = 0;
  private shake = 0;
  private hitStop = 0;
  private ending = 0;
  private particles: Particle[] = [];
  private popups: { t: Text; life: number }[] = [];
  private banner: Text | null = null;
  private bannerT = 0;
  private readonly fast = prefersReducedMotion();

  private constructor(
    private readonly app: Application,
    private skin: Skin,
    private readonly options: NeonCoilViewOptions,
  ) {
    this.fruitHalo = new Sprite(this.halo);
    this.fruitHalo.anchor.set(0.5);
    this.fruitHalo.tint = APPLE;
    this.fruitHalo.blendMode = "add";
    this.glowLayer.blendMode = "add";
    this.fx.blendMode = "add";
    this.board.addChild(this.arena, this.border, this.fruitHalo, this.fruit, this.glowLayer, this.bodyLayer, this.face, this.fx);
    app.stage.addChild(this.board, this.hud);
    app.ticker.add(this.animate);
    app.renderer.on("resize", this.layout);
    this.load(1);
  }

  static async create(host: HTMLElement, skin: Skin, options: NeonCoilViewOptions): Promise<NeonCoilView> {
    return new NeonCoilView(await createPixi(host), skin, options);
  }

  destroy(): void {
    this.app.ticker.remove(this.animate);
    this.app.renderer.off("resize", this.layout);
    this.app.destroy({ removeView: true }, { children: true });
    this.disc.destroy(true);
    this.halo.destroy(true);
  }

  get state(): Phase {
    return this.phase;
  }

  setSkin(skin: Skin): void {
    this.skin = skin;
    this.drawBorder();
  }

  /** Sets up `level`, waiting for the first move. */
  load(level: number): void {
    const { width, height } = this.app.screen;
    const { cols, rows } = boardFor(width, height);
    this.level = level;
    this.tick = levelTick(level);
    this.snake = new Snake(cols, rows, levelWalls(level, cols, rows), fruitGoal(level));
    this.prev = this.snake.body.map((c) => ({ ...c }));
    this.acc = 0;
    this.phase = "ready";
    this.ending = 0;
    this.hitStop = 0;
    this.shake = 0;
    this.fruitBorn = this.clock;
    for (const p of this.particles) p.s.destroy();
    this.particles = [];
    this.options.onEat(0, this.snake.goal, 1);
    this.layout();
  }

  start(): void {
    if (this.phase === "ready" || this.phase === "paused") this.phase = "running";
  }

  pause(): void {
    if (this.phase === "running") this.phase = "paused";
  }

  /** Steers (and starts the level from the ready screen). */
  turn(dir: Dir): void {
    if (this.phase === "ready") this.start();
    if (this.phase !== "running") return;
    // Just left a cell? Take the turn from that cell instead of waiting for the next.
    if (this.acc < this.tick * LATE_TURN) {
      const redo = this.snake.lateTurn(dir);
      if (redo) {
        this.handle(redo);
        return;
      }
    }
    this.snake.turn(dir);
  }

  // ---------------------------------------------------------------- layout

  private readonly layout = () => {
    const { width, height } = this.app.screen;
    if (!this.snake) return;
    const { cols, rows } = this.snake;
    // Before the first move the board can still take the screen's new shape.
    if (this.phase === "ready" && this.snake.moves === 0 && this.cell) {
      const fit = boardFor(width, height);
      if (fit.cols !== cols || fit.rows !== rows) {
        this.load(this.level);
        return;
      }
    }
    const pad = 6;
    this.cell = Math.max(4, Math.floor(Math.min((width - pad * 2) / cols, (height - pad * 2) / rows)));
    this.ox = Math.round((width - this.cell * cols) / 2);
    this.oy = Math.round((height - this.cell * rows) / 2);
    this.drawArena();
    this.drawBorder();
    this.drawFruitShape();
  };

  private px(x: number): number {
    return this.ox + (x + 0.5) * this.cell;
  }

  private py(y: number): number {
    return this.oy + (y + 0.5) * this.cell;
  }

  /** The background, grid dots and walls: drawn once per level or resize. */
  private drawArena(): void {
    const c = this.cell;
    const { cols, rows } = this.snake;
    const a = this.arena.clear();
    a.roundRect(this.ox, this.oy, c * cols, c * rows, c * 0.6).fill({ color: ARENA, alpha: 0.94 });
    const dot = Math.max(1, c * 0.06);
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        if (!this.snake.isWall(x, y)) a.rect(this.px(x) - dot / 2, this.py(y) - dot / 2, dot, dot);
      }
    }
    a.fill({ color: GRID_DOT });
    const inset = Math.max(1, c * 0.08);
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        if (!this.snake.isWall(x, y)) continue;
        a.roundRect(this.ox + x * c + inset, this.oy + y * c + inset, c - inset * 2, c - inset * 2, c * 0.22)
          .fill({ color: WALL })
          .stroke({ width: Math.max(1, c * 0.07), color: WALL_EDGE, alpha: 0.85 });
      }
    }
  }

  private drawBorder(): void {
    const c = this.cell;
    const { cols, rows } = this.snake;
    const r = c * 0.6;
    const b = this.border.clear();
    b.roundRect(this.ox - 2, this.oy - 2, c * cols + 4, c * rows + 4, r + 2).stroke({ width: 6, color: 0xffffff, alpha: 0.18 });
    b.roundRect(this.ox, this.oy, c * cols, c * rows, r).stroke({ width: 1.5, color: 0xffffff, alpha: 0.8 });
    b.tint = this.skin.glow;
  }

  /** The apple, drawn once around (0, 0) and then only moved and scaled. */
  private drawFruitShape(): void {
    const r = this.cell * 0.36;
    this.fruit
      .clear()
      .circle(0, 0, r)
      .fill({ color: APPLE })
      .circle(-r * 0.32, -r * 0.32, r * 0.3)
      .fill({ color: 0xffffff, alpha: 0.75 })
      .ellipse(r * 0.35, -r * 1.05, r * 0.38, r * 0.18)
      .fill({ color: 0x4ade80 });
    this.fruitHalo.width = this.fruitHalo.height = this.cell * 2.4;
  }

  // ---------------------------------------------------------------- loop

  private readonly animate = () => {
    const dt = Math.min(this.app.ticker.deltaMS, MAX_FRAME_MS);
    this.clock += dt;
    if (this.hitStop > 0) {
      this.hitStop -= dt;
    } else if (this.phase === "running") {
      this.acc += dt;
      while (this.acc >= this.tick && this.phase === "running") {
        this.prev = this.snake.body.map((c) => ({ ...c }));
        this.acc -= this.tick;
        this.handle(this.snake.step());
      }
    } else if (this.phase === "ending") {
      this.ending += dt;
      const done = this.snake.cleared ? CLEAR_MS : DISSOLVE_MS;
      if (this.ending >= done) {
        this.phase = "done";
        this.options.onEnd({
          level: this.level,
          cleared: this.snake.cleared,
          stars: this.snake.cleared ? this.snake.stars() : 0,
          moves: this.snake.moves,
          par: this.snake.par,
        });
      }
    }
    const frac = this.phase === "running" ? Math.min(1, this.acc / this.tick) : 1;
    this.border.alpha = 0.75 + 0.25 * Math.sin(this.clock / 600);
    this.drawFruit();
    this.drawSnake(frac);
    this.updateFx(dt);
  };

  private handle(event: StepEvent): void {
    this.options.onStep(event);
    if (event.ate) {
      const x = this.px(event.ate.x);
      const y = this.py(event.ate.y);
      this.burst(x, y, [APPLE, this.skin.head, 0xffffff], 14);
      this.popup(x, y, `${this.snake.eaten}/${this.snake.goal}`);
      this.fruitBorn = this.clock;
      const faster = levelTick(this.level, this.snake.eaten);
      if (faster < this.tick && !event.cleared) {
        this.tick = faster;
        this.showBanner("SPEED UP");
      }
      this.options.onEat(this.snake.eaten, this.snake.goal, speedStep(this.snake.eaten));
    }
    if (event.cleared) {
      this.phase = "ending";
      this.ending = 0;
      this.prev = this.snake.body.map((c) => ({ ...c }));
      this.showBanner("LEVEL CLEAR!");
      const head = this.snake.body[0];
      if (head) this.burst(this.px(head.x), this.py(head.y), [this.skin.head, this.skin.tail, 0xffffff, 0xfacc15], 40);
    }
    if (event.died) {
      this.phase = "ending";
      this.ending = 0;
      this.hitStop = this.fast ? 0 : HIT_STOP_MS;
      this.shake = this.fast ? 0 : 380;
      this.prev = this.snake.body.map((c) => ({ ...c }));
    }
  }

  // ---------------------------------------------------------------- drawing

  private drawFruit(): void {
    const show = !this.snake.cleared;
    this.fruit.visible = this.fruitHalo.visible = show;
    if (!show) return;
    const x = this.px(this.snake.fruit.x);
    const y = this.py(this.snake.fruit.y);
    const born = this.fast ? 1 : ease.outBack(Math.min(1, (this.clock - this.fruitBorn) / 260));
    const pulse = 1 + 0.07 * Math.sin(this.clock / 160);
    this.fruit.position.set(x, y);
    this.fruit.scale.set(born * pulse);
    this.fruitHalo.position.set(x, y);
    this.fruitHalo.alpha = 0.55 * born;
  }

  /**
   * The snake's path in pixels, head first: the head part-way into its newest cell,
   * then each cell centre the body runs through, then the tail part-way out of the
   * cell it is leaving.
   */
  private path(frac: number): Pt[] {
    const cur = this.snake.body;
    const n = cur.length;
    const first = cur[0];
    if (!first) return [];
    const from = this.prev[0] ?? first;
    const pts: Pt[] = [[this.px(lerp(from.x, first.x, frac)), this.py(lerp(from.y, first.y, frac))]];
    for (let i = 1; i < n; i++) {
      const c = cur[i];
      if (c) pts.push([this.px(c.x), this.py(c.y)]);
    }
    const last = cur[n - 1];
    const gone = this.prev[n - 1];
    // When the snake didn't grow, its old tail cell is still being left behind.
    if (last && gone && this.prev.length === n) {
      pts.push([this.px(lerp(gone.x, last.x, frac)), this.py(lerp(gone.y, last.y, frac))]);
    }
    return pts;
  }

  private sprite(pool: Sprite[], layer: Container, i: number, texture: Texture): Sprite {
    let s = pool[i];
    if (!s) {
      s = new Sprite(texture);
      s.anchor.set(0.5);
      pool.push(s);
      layer.addChild(s);
    }
    s.visible = true;
    return s;
  }

  private drawSnake(frac: number): void {
    const c = this.cell;
    const pts = this.path(frac);
    // Lengths along the path.
    const seg: number[] = [];
    let total = 0;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1] as Pt;
      const b = pts[i] as Pt;
      const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
      seg.push(d);
      total += d;
    }
    const spacing = c / SAMPLES_PER_CELL;
    const count = Math.max(1, Math.floor(total / spacing) + 1);
    const dying = this.phase === "ending" && !this.snake.cleared;
    const won = this.snake.cleared;
    const flash = dying && this.hitStop > 0;
    const dissolve = dying && this.hitStop <= 0 ? Math.min(1, this.ending / DISSOLVE_MS) : 0;
    const winGlow = won ? 0.5 + 0.5 * Math.sin(this.clock / 70) : 0;

    // Walk the path once, placing sprites from the tail (drawn first) to the head.
    let used = 0;
    let glows = 0;
    let si = 0;
    let into = 0;
    const at = (d: number): Pt => {
      while (si < seg.length - 1 && into + (seg[si] ?? 0) < d) {
        into += seg[si] ?? 0;
        si += 1;
      }
      const a = pts[si] ?? pts[0] ?? [0, 0];
      const b = pts[si + 1] ?? a;
      const len = seg[si] ?? 0;
      const t = len > 0 ? Math.min(1, (d - into) / len) : 0;
      return [lerp(a[0], b[0], t), lerp(a[1], b[1], t)];
    };
    const samples: Pt[] = [];
    for (let k = 0; k < count; k++) samples.push(at(Math.min(total, k * spacing)));
    for (let k = count - 1; k >= 0; k--) {
      const along = count > 1 ? k / (count - 1) : 0;
      // Dying: the snake comes apart from the head down to the tail.
      if (along < dissolve) continue;
      const p = samples[k] as Pt;
      const r = c * (0.43 - 0.17 * along);
      const s = this.sprite(this.bodySprites, this.bodyLayer, used++, this.disc);
      s.position.set(p[0], p[1]);
      s.width = s.height = r * 2;
      const base = mix(this.skin.head, this.skin.tail, along);
      s.tint = flash ? 0xffffff : dying ? mix(base, 0xff3b3b, 0.55) : won ? mix(base, 0xffffff, winGlow * 0.5) : base;
      if (k % 3 === 0) {
        const g = this.sprite(this.glowSprites, this.glowLayer, glows++, this.halo);
        g.position.set(p[0], p[1]);
        g.width = g.height = r * 4.2;
        g.tint = flash || dying ? 0xff3b3b : this.skin.glow;
        g.alpha = won ? 0.5 + 0.4 * winGlow : 0.42;
      }
    }
    // Sprites are added to the layer in pool order; keep the head on top.
    for (let i = used; i < this.bodySprites.length; i++) (this.bodySprites[i] as Sprite).visible = false;
    for (let i = glows; i < this.glowSprites.length; i++) (this.glowSprites[i] as Sprite).visible = false;

    // Dying bits fly off where the body is coming apart.
    if (dissolve > 0 && dissolve < 1 && this.particles.length < 200) {
      const p = samples[Math.floor(dissolve * (count - 1))];
      if (p) this.burst(p[0], p[1], [this.skin.head, this.skin.glow, 0xff3b3b], this.fast ? 1 : 3);
    }
    this.drawFace(samples, dissolve > 0, dying);
  }

  /** Eyes that look at the fruit (crosses when crashed) and a tongue now and then. */
  private drawFace(samples: Pt[], hidden: boolean, dying: boolean): void {
    const f = this.face.clear();
    const head = samples[0];
    if (!head || hidden) return;
    const c = this.cell;
    const back = samples[Math.min(samples.length - 1, 2)] ?? head;
    let dx = head[0] - back[0];
    let dy = head[1] - back[1];
    const len = Math.hypot(dx, dy);
    if (len < 0.001) {
      const v = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }[this.snake.dir];
      [dx, dy] = v as [number, number];
    } else {
      dx /= len;
      dy /= len;
    }
    const nx = -dy;
    const ny = dx;
    let lx = this.px(this.snake.fruit.x) - head[0];
    let ly = this.py(this.snake.fruit.y) - head[1];
    const tl = Math.hypot(lx, ly) || 1;
    lx /= tl;
    ly /= tl;
    if (!dying && !this.fast && this.clock % 2400 < 200) {
      const tx = head[0] + dx * c * 0.42;
      const ty = head[1] + dy * c * 0.42;
      const reach = c * 0.32 * Math.sin(((this.clock % 2400) / 200) * Math.PI);
      const ex = tx + dx * reach;
      const ey = ty + dy * reach;
      const w = Math.max(1.5, c * 0.07);
      f.moveTo(tx, ty).lineTo(ex, ey);
      for (const side of [-1, 1]) f.moveTo(ex, ey).lineTo(ex + (dx + nx * side) * c * 0.1, ey + (dy + ny * side) * c * 0.1);
      f.stroke({ width: w, color: 0xff4d6d, cap: "round" });
    }
    const er = c * 0.12;
    for (const side of [-1, 1]) {
      const ex = head[0] + nx * side * c * 0.19 + dx * c * 0.08;
      const ey = head[1] + ny * side * c * 0.19 + dy * c * 0.08;
      f.circle(ex, ey, er).fill({ color: 0xffffff });
      if (dying) {
        const k = er * 0.6;
        f.moveTo(ex - k, ey - k).lineTo(ex + k, ey + k).moveTo(ex + k, ey - k).lineTo(ex - k, ey + k).stroke({ width: 1.5, color: 0x0b1020 });
      } else {
        f.circle(ex + lx * er * 0.4, ey + ly * er * 0.4, er * 0.55).fill({ color: 0x0b1020 });
      }
    }
  }

  // ---------------------------------------------------------------- effects

  private burst(x: number, y: number, colors: number[], count: number): void {
    const n = this.fast ? Math.ceil(count / 3) : count;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const speed = (0.6 + Math.random() * 2.2) * Math.max(1, this.cell / 18);
      const s = new Sprite(this.disc);
      s.anchor.set(0.5);
      s.width = s.height = Math.max(2.4, this.cell * (0.1 + Math.random() * 0.14));
      s.tint = colors[i % colors.length] ?? 0xffffff;
      s.position.set(x, y);
      this.fx.addChild(s);
      const life = 360 + Math.random() * 380;
      this.particles.push({ s, vx: Math.cos(a) * speed, vy: Math.sin(a) * speed, life, max: life });
    }
  }

  private popup(x: number, y: number, text: string): void {
    const t = new Text({
      text,
      style: {
        fontFamily: "ui-rounded, system-ui, sans-serif",
        fontWeight: "800",
        fontSize: Math.max(13, this.cell * 0.7),
        fill: 0xffffff,
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
        fontSize: Math.max(26, this.cell * 1.8),
        fill: 0xffffff,
        letterSpacing: 4,
        stroke: { color: this.skin.glow, width: 4 },
      },
    });
    t.anchor.set(0.5);
    t.position.set(this.app.screen.width / 2, this.app.screen.height * 0.4);
    this.hud.addChild(t);
    this.banner = t;
    this.bannerT = 0;
  }

  private updateFx(dt: number): void {
    const k = dt / 16.67;
    this.particles = this.particles.filter((p) => {
      p.life -= dt;
      if (p.life <= 0) {
        p.s.destroy();
        return false;
      }
      p.s.x += p.vx * k;
      p.s.y += p.vy * k;
      p.vx *= Math.pow(0.94, k);
      p.vy *= Math.pow(0.94, k);
      p.s.alpha = p.life / p.max;
      return true;
    });
    this.popups = this.popups.filter((p) => {
      p.life += dt;
      if (p.life >= 700) {
        p.t.destroy();
        return false;
      }
      const u = p.life / 700;
      p.t.y -= 0.6 * k;
      p.t.alpha = u < 0.6 ? 1 : 1 - (u - 0.6) / 0.4;
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
      const m = Math.max(0, this.shake / 380) * this.cell * 0.22;
      this.board.position.set((Math.random() - 0.5) * m, (Math.random() - 0.5) * m);
    } else if (this.shake <= 0) {
      this.board.position.set(0, 0);
    }
  }
}
