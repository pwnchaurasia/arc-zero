import {
  Application,
  Container,
  Graphics,
  Rectangle,
  Sprite,
  Text,
  type FederatedPointerEvent,
  type Texture,
} from "pixi.js";

import type { BbState } from "../../api/types";
import { haptic, sfx } from "../../feel/audio";
import { bbConstants, engine, type BbConstants } from "../../engine/wasm";
import { hpColor } from "../colors";
import { drawBevelled } from "./bevel";
import { createPixi, prefersReducedMotion, tween } from "../pixi";

/** Engine encodings (see crates/arc-engine-wasm): cells are [tag, kind, hp]. */
const SHAPES = ["square", "tri_bl", "tri_br", "tri_tl", "tri_tr"] as const;
/** Indexed by the engine's power-up kind (new kinds are appended there too). */
const POWER_GLYPH = ["↔", "↕", "✚", "×3", "×5", "+2", "+3", "+5", "✦", "2×", "3×"];
const POWER_COLOR = [
  0xf43f5e, 0xf43f5e, 0xf43f5e, 0x38bdf8, 0x38bdf8, 0xfacc15, 0xfacc15, 0xfacc15,
  // scatter, boost x2, boost x3
  0xa855f7, 0x22c55e, 0xf59e0b,
];
/** Gap between on-screen messages, so they never pile up. */
const ANNOUNCE_GAP_MS = 650;
const MAX_STEPS_PER_FRAME = 48;

/** On release, fire the aim from this long before the lift (finger-lift jitter). */
const LIFT_SETTLE_MS = 100;
/** Larger last-moment changes than this (tenths of a degree) are deliberate: keep them. */
const LIFT_JITTER_TENTHS = 40;

export interface BrickBlastViewOptions {
  onFire: (aim: number) => void;
  /** Called with a column when the laser assist is picking one. */
  onColumn?: (col: number) => void;
}

/** Minimal interface of the WASM `BrickTurn` used for playback. */
export interface TurnSim {
  step(): boolean;
  isDone(): boolean;
  waiting(): number;
  balls(): Int32Array;
  cells(): Int32Array;
  takeEvents(): Int32Array;
}

interface CellView {
  key: string;
  node: Container | null;
  color: number;
}

export class BrickBlastView {
  private readonly c: BbConstants = bbConstants();
  private readonly board = new Container();
  private readonly frame = new Graphics();
  /** Soft background glow and drifting particles behind the blocks. */
  private readonly ambient = new Container();
  private readonly cellLayer = new Container();
  private readonly guide = new Graphics();
  /** Outline of the block the aimed shot hits first; blinks while aiming. */
  private readonly hitMark = new Graphics();
  private readonly fx = new Container();
  private readonly ballGlowLayer = new Container();
  private readonly ballLayer = new Container();
  private readonly launcher = new Graphics();
  private readonly launcherGlow: Sprite;
  private readonly ballCount: Text;
  private readonly ballTexture: Texture;
  /** Radial soft-glow texture, tinted and blended additively for halos and flashes. */
  private readonly glowTexture: Texture;
  private readonly ballPool: Sprite[] = [];
  private readonly glowPool: Sprite[] = [];
  private motes: { node: Graphics; speed: number; phase: number }[] = [];
  private cells: CellView[] = [];
  private scale = 1;
  private state: BbState | null = null;
  private stateJson = "";
  private launchX = 0;
  private aimEnabled = false;
  private aiming = false;
  private aim: number | null = null;
  private hintAim: number | null = null;
  /** Recent aims while dragging, `[time, aim]`, newest last (see `settledAim`). */
  private aimTrail: [number, number][] = [];
  private speed = 1;
  private skipping = false;
  private combo = 0;
  /** Per-shot tallies for the messages ("Good shot!", "Multi break!"...). */
  private shot = { blasts: 0, powers: 0, laser: false, scatter: false, lastBall: false, recent: [] as number[] };
  private tick = 0;
  private lastAnnounce = 0;
  private picking = false;
  private pickCol: number | null = null;
  private readonly picker = new Graphics();
  private pulse = 0;
  private destroyed = false;

  private constructor(
    private readonly app: Application,
    private readonly options: BrickBlastViewOptions,
  ) {
    this.ballTexture = app.renderer.generateTexture(
      new Graphics().circle(0, 0, 32).fill(0xffffff),
    );
    const glow = new Graphics();
    for (let r = 64; r > 0; r -= 4) glow.circle(0, 0, r).fill({ color: 0xffffff, alpha: 0.05 });
    this.glowTexture = app.renderer.generateTexture(glow);
    glow.destroy();
    this.launcherGlow = new Sprite(this.glowTexture);
    this.launcherGlow.anchor.set(0.5);
    this.launcherGlow.blendMode = "add";
    this.launcherGlow.tint = 0xbfe9ff;
    this.ballCount = new Text({
      text: "",
      style: { fontSize: 14, fill: 0xe8ecff, fontWeight: "700" },
    });
    this.ballCount.anchor.set(0.5, 0);
    this.ballGlowLayer.blendMode = "add";
    this.board.addChild(
      this.frame,
      this.ambient,
      this.cellLayer,
      this.hitMark,
      this.guide,
      this.fx,
      this.ballGlowLayer,
      this.ballLayer,
      this.launcherGlow,
      this.launcher,
      this.ballCount,
      this.picker,
    );
    app.stage.addChild(this.board);
    app.stage.eventMode = "static";
    app.stage.hitArea = app.screen;
    app.stage.on("pointerdown", this.onDown);
    app.stage.on("pointermove", this.onMove);
    app.stage.on("pointerup", this.onUp);
    app.stage.on("pointerupoutside", this.onUp);
    app.renderer.on("resize", this.layout);
    app.ticker.add(this.animatePowerUps);
    this.layout();
  }

  static async create(host: HTMLElement, options: BrickBlastViewOptions) {
    return new BrickBlastView(await createPixi(host), options);
  }

  destroy(): void {
    this.destroyed = true;
    this.app.renderer.off("resize", this.layout);
    this.app.ticker.remove(this.animatePowerUps);
    this.ballTexture.destroy(true);
    this.glowTexture.destroy(true);
    this.app.destroy({ removeView: true }, { children: true });
  }

  /** Shows a settled board (between turns). */
  setState(state: BbState): void {
    this.state = state;
    this.stateJson = JSON.stringify(state);
    this.launchX = state.launch_x;
    this.renderCells(engine.bbCells(this.stateJson));
    this.renderBalls(new Int32Array(0));
    this.drawLauncher(launchCount(state));
    this.drawGuide();
    if (state.status === "playing" && dangerRow(engine.bbCells(this.stateJson), this.c.cols, this.c.playRows)) {
      this.announce("Danger zone!", 0xf87171);
    }
  }

  /** Laser assist: the next tap picks a column instead of aiming. */
  setColumnPicking(on: boolean): void {
    this.picking = on;
    this.pickCol = null;
    this.drawPicker();
  }

  setAimEnabled(on: boolean): void {
    this.aimEnabled = on;
    if (!on) {
      this.aiming = false;
      this.aim = null;
    }
    this.drawGuide();
  }

  showHintAim(aim: number | null): void {
    this.hintAim = aim;
    this.drawGuide();
  }

  setSpeed(speed: number): void {
    this.speed = speed;
  }

  skip(): void {
    this.skipping = true;
  }

  /** Animates a turn already started in WASM until the simulation finishes. */
  play(turn: TurnSim): Promise<void> {
    this.skipping = false;
    this.combo = 0;
    this.tick = 0;
    this.shot = { blasts: 0, powers: 0, laser: false, scatter: false, lastBall: false, recent: [] };
    this.hintAim = null;
    this.drawGuide();
    const tps = this.c.ticksPerSecond;
    let acc = 0;
    return new Promise((resolve) => {
      const frame = () => {
        if (this.destroyed) {
          this.app.ticker.remove(frame);
          resolve();
          return;
        }
        let steps: number;
        if (this.skipping) {
          steps = Number.MAX_SAFE_INTEGER;
        } else {
          acc += (this.app.ticker.deltaMS / 1000) * tps * this.speed;
          steps = Math.min(Math.floor(acc), MAX_STEPS_PER_FRAME);
          acc -= steps;
        }
        let changed = false;
        for (let i = 0; i < steps && !turn.isDone(); i++) {
          turn.step();
          this.tick += 1;
          if (this.skipping) continue;
          const lone = turn.waiting() === 0 && turn.balls().length === 4; // one ball: [id, x, y, clone]
          changed = this.handleEvents(turn.takeEvents(), lone) || changed;
        }
        if (this.skipping) turn.takeEvents();
        if (changed || this.skipping) this.renderCells(turn.cells());
        this.renderBalls(turn.isDone() ? new Int32Array(0) : turn.balls());
        this.drawLauncher(turn.waiting());
        if (turn.isDone()) {
          this.app.ticker.remove(frame);
          if (!this.skipping) this.summarise();
          resolve();
        }
      };
      this.app.ticker.add(frame);
    });
  }

  // ---------------------------------------------------------------- layout

  private readonly layout = () => {
    if (this.destroyed) return;
    const { width: W, height: H } = this.app.screen;
    const { boardW, floorY, cell } = this.c;
    const totalH = floorY + cell * 0.9;
    this.scale = Math.min((W * 0.96) / boardW, (H * 0.98) / totalH);
    this.board.scale.set(this.scale);
    this.board.position.set((W - boardW * this.scale) / 2, (H - totalH * this.scale) / 2);
    this.app.stage.hitArea = new Rectangle(0, 0, W, H);
    this.drawFrame();
    this.cells = [];
    this.cellLayer.removeChildren().forEach((n) => n.destroy({ children: true }));
    if (this.state) this.setState(this.state);
  };

  private drawFrame(): void {
    const { boardW, floorY, cell, playRows } = this.c;
    const line = 2 / this.scale;
    this.frame
      .clear()
      .roundRect(0, 0, boardW, floorY, cell * 0.25)
      .fill({ color: 0x0f1630 })
      .stroke({ width: line, color: 0x2a3560 });
    // Danger zone: the ground row. A block landing here ends the game.
    this.frame.rect(0, playRows * cell, boardW, cell).fill({ color: 0xef4444, alpha: 0.08 });
    for (let x = cell * 0.25; x < boardW; x += cell * 0.5) {
      this.frame.rect(x, playRows * cell, cell * 0.25, line * 1.5).fill({ color: 0xef4444, alpha: 0.5 });
    }
    this.drawAmbient();
  }

  /** A soft teal/violet glow and slowly drifting motes, like the game's key art. */
  private drawAmbient(): void {
    const { boardW, floorY, cell, ballR } = this.c;
    this.ambient.removeChildren().forEach((n) => n.destroy());
    this.motes = [];
    const glows: [number, number, number, number][] = [
      [boardW * 0.28, floorY * 0.5, cell * 7, 0x14b8a6],
      [boardW * 0.75, floorY * 0.3, cell * 6, 0x8b5cf6],
    ];
    for (const [x, y, size, tint] of glows) {
      const g = new Sprite(this.glowTexture);
      g.anchor.set(0.5);
      g.position.set(x, y);
      g.width = g.height = size;
      g.tint = tint;
      g.alpha = 0.35;
      g.blendMode = "add";
      this.ambient.addChild(g);
    }
    for (let i = 0; i < 22; i++) {
      const node = new Graphics()
        .circle(0, 0, ballR * (0.18 + Math.random() * 0.3))
        .fill({ color: i % 3 ? 0x7dd3fc : 0xffffff, alpha: 1 });
      node.position.set(Math.random() * boardW, Math.random() * floorY);
      node.alpha = 0.15 + Math.random() * 0.3;
      this.ambient.addChild(node);
      this.motes.push({ node, speed: 0.15 + Math.random() * 0.35, phase: Math.random() * 6 });
    }
  }

  // ----------------------------------------------------------------- cells

  /**
   * The board container is in engine units (thousands per cell), so text is
   * rasterised at its on-screen pixel size and counter-scaled. Otherwise each
   * label would allocate a texture thousands of pixels wide.
   */
  private makeText(text: string, logicalSize: number, fill: number, outlined = false): Text {
    const fontSize = Math.max(6, logicalSize * this.scale);
    const t = new Text({
      text,
      style: {
        fontSize,
        fill,
        fontWeight: "800",
        // A soft dark outline keeps numbers readable on the light facets of a block.
        ...(outlined ? { stroke: { color: 0x000000, width: fontSize * 0.14, alpha: 0.45 } } : {}),
      },
    });
    t.anchor.set(0.5);
    t.scale.set(1 / this.scale);
    return t;
  }

  private renderCells(flat: Int32Array): void {
    const { cols, cell, blockInset, powerR } = this.c;
    const count = flat.length / 3;
    for (let i = 0; i < count; i++) {
      const tag = (flat[i * 3] ?? 0);
      const kind = (flat[i * 3 + 1] ?? 0);
      const hp = (flat[i * 3 + 2] ?? 0);
      const key = `${tag}:${kind}:${hp}`;
      const view = (this.cells[i] ??= { key: "", node: null, color: 0 });
      if (view.key === key) continue;
      view.key = key;
      view.node?.destroy({ children: true });
      view.node = null;
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x0 = col * cell;
      const y0 = row * cell;

      if (tag === 1) {
        const color = hpColor(hp);
        view.color = color;
        const node = new Container();
        const g = new Graphics();
        const a = blockInset;
        const b = cell - blockInset;
        const pts: Record<(typeof SHAPES)[number], number[]> = {
          square: [a, a, b, a, b, b, a, b],
          tri_bl: [a, b, a, a, b, b],
          tri_br: [b, b, a, b, b, a],
          tri_tl: [a, a, b, a, a, b],
          tri_tr: [b, a, b, b, a, a],
        };
        const shape = SHAPES[kind] ?? "square";
        const centre = drawBevelled(g, pts[shape], color, cell * 0.025);
        const label = this.makeText(String(hp), cell * (hp >= 100 ? 0.3 : 0.36), 0xffffff, true);
        label.position.set(centre.x, centre.y);
        node.addChild(g, label);
        node.position.set(x0, y0);
        this.cellLayer.addChild(node);
        view.node = node;
      } else if (tag === 2) {
        const node = new Container();
        const color = POWER_COLOR[kind] ?? 0xffffff;
        const halo = new Sprite(this.glowTexture);
        halo.anchor.set(0.5);
        halo.width = halo.height = powerR * 3.6;
        halo.tint = color;
        halo.alpha = 0.7;
        halo.blendMode = "add";
        const ring = new Graphics()
          .circle(0, 0, powerR)
          .stroke({ width: cell * 0.11, color, alpha: 0.35 })
          .circle(0, 0, powerR)
          .stroke({ width: cell * 0.05, color })
          .circle(0, 0, powerR * 0.86)
          .stroke({ width: cell * 0.015, color: 0xffffff, alpha: 0.7 });
        const sparkles = new Graphics();
        sparkles.label = "sparkles";
        for (const [dx, dy, r] of [[0.9, -0.85, 0.16], [-0.95, 0.15, 0.11], [0.55, 0.95, 0.09]] as const) {
          const R = cell * r;
          const cx = powerR * dx;
          const cy = powerR * dy;
          sparkles
            .poly([cx, cy - R, cx + R * 0.25, cy - R * 0.25, cx + R, cy, cx + R * 0.25, cy + R * 0.25,
              cx, cy + R, cx - R * 0.25, cy + R * 0.25, cx - R, cy, cx - R * 0.25, cy - R * 0.25])
            .fill({ color: 0xffffff, alpha: 0.9 });
        }
        node.addChild(halo, ring, sparkles);
        node.addChild(this.makeText(POWER_GLYPH[kind] ?? "?", cell * 0.24, 0xffffff, true));
        node.position.set(x0 + cell / 2, y0 + cell / 2);
        node.label = "power";
        this.cellLayer.addChild(node);
        view.node = node;
      }
    }
  }

  private readonly animatePowerUps = () => {
    const dt = this.app.ticker.deltaMS / 1000;
    this.pulse += dt;
    const still = prefersReducedMotion();
    this.hitMark.alpha = still ? 0.9 : 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(this.pulse * 12));
    const s = still ? 1 : 1 + Math.sin(this.pulse * 4) * 0.06;
    for (const v of this.cells) {
      if (v.node?.label !== "power") continue;
      v.node.scale.set(s);
      const sparkles = v.node.getChildByLabel("sparkles");
      if (sparkles && !still) sparkles.alpha = 0.55 + Math.sin(this.pulse * 6 + v.color) * 0.45;
    }
    if (still) return;
    const { floorY, cell } = this.c;
    for (const m of this.motes) {
      m.node.y -= m.speed * cell * dt;
      if (m.node.y < 0) m.node.y = floorY;
      m.node.alpha = 0.12 + (Math.sin(this.pulse * 1.5 + m.phase) + 1) * 0.14;
    }
  };

  // ----------------------------------------------------------------- balls

  private renderBalls(flat: Int32Array): void {
    const count = flat.length / 4;
    const size = (this.c.ballR * 2) / 64;
    const glowSize = (this.c.ballR * 5) / 128;
    while (this.ballPool.length < count) {
      const s = new Sprite(this.ballTexture);
      s.anchor.set(0.5);
      s.scale.set(size);
      this.ballLayer.addChild(s);
      this.ballPool.push(s);
      const g = new Sprite(this.glowTexture);
      g.anchor.set(0.5);
      g.scale.set(glowSize);
      g.alpha = 0.55;
      g.blendMode = "add";
      this.ballGlowLayer.addChild(g);
      this.glowPool.push(g);
    }
    for (let i = 0; i < this.ballPool.length; i++) {
      const s = this.ballPool[i];
      const g = this.glowPool[i];
      if (!s || !g) continue;
      if (i >= count) {
        s.visible = g.visible = false;
        continue;
      }
      s.visible = g.visible = true;
      const x = flat[i * 4 + 1] ?? 0;
      const y = flat[i * 4 + 2] ?? 0;
      const clone = (flat[i * 4 + 3] ?? 0) !== 0;
      s.position.set(x, y);
      g.position.set(x, y);
      s.tint = clone ? 0xa5f3fc : 0xffffff;
      g.tint = clone ? 0x22d3ee : 0x9bdcff;
    }
  }

  private drawLauncher(waiting: number): void {
    const { floorY, ballR } = this.c;
    this.launcher.clear();
    this.launcherGlow.visible = waiting > 0;
    if (waiting > 0) {
      this.launcher.circle(this.launchX, floorY - ballR - 1, ballR).fill(0xffffff);
      this.launcherGlow.position.set(this.launchX, floorY - ballR - 1);
      this.launcherGlow.width = this.launcherGlow.height = ballR * 6;
      this.launcherGlow.alpha = 0.6;
    }
    const boost = this.state?.boost ?? 1;
    const bonus = this.state?.bonus ?? 0;
    const extra = boost > 1 ? ` · ${boost}×` : bonus > 0 ? ` · +${bonus}` : "";
    this.ballCount.text = waiting > 0 ? `×${waiting}${this.aimEnabled ? extra : ""}` : "";
    this.ballCount.style.fill = this.aimEnabled && (boost > 1 || bonus > 0) ? 0x4ade80 : 0xe8ecff;
    this.ballCount.style.fontSize = Math.max(8, this.c.cell * 0.3 * this.scale);
    this.ballCount.scale.set(1 / this.scale);
    this.ballCount.position.set(this.launchX, floorY + ballR * 0.6);
  }

  // ------------------------------------------------------------------- aim

  private launchPoint(): { x: number; y: number } {
    const { floorY, ballR } = this.c;
    return {
      x: this.board.x + this.launchX * this.scale,
      y: this.board.y + (floorY - ballR) * this.scale,
    };
  }

  private aimFrom(e: FederatedPointerEvent): number | null {
    const p = this.launchPoint();
    const dx = e.global.x - p.x;
    const dy = p.y - e.global.y;
    if (dy < 8) return null;
    const tenths = Math.round((Math.atan2(dy, dx) * 1800) / Math.PI);
    return Math.max(this.c.aimMin, Math.min(this.c.aimMax, tenths));
  }

  private readonly onDown = (e: FederatedPointerEvent) => {
    sfx.unlock();
    if (this.picking) {
      this.pickCol = this.colFrom(e);
      this.drawPicker();
      return;
    }
    if (!this.aimEnabled) return;
    this.aiming = true;
    this.aim = this.aimFrom(e);
    this.aimTrail = this.aim === null ? [] : [[performance.now(), this.aim]];
    this.drawGuide();
  };

  private readonly onMove = (e: FederatedPointerEvent) => {
    if (this.picking && this.pickCol !== null) {
      this.pickCol = this.colFrom(e);
      this.drawPicker();
      return;
    }
    if (!this.aiming) return;
    const next = this.aimFrom(e);
    if (next !== this.aim) {
      this.aim = next;
      if (next !== null) {
        this.aimTrail.push([performance.now(), next]);
        if (this.aimTrail.length > 24) this.aimTrail.shift();
      }
      this.drawGuide();
    }
  };

  /**
   * The aim to fire on release. Lifting a finger rolls the touch point a few
   * pixels (very noticeable on Android), which near the ball turns the aim by a
   * few degrees. So use the aim from just before the lift, unless the last
   * moment's change was big enough to be a deliberate adjustment.
   */
  private settledAim(): number | null {
    const now = this.aim;
    if (now === null) return null;
    const cutoff = performance.now() - LIFT_SETTLE_MS;
    let before: number | null = null;
    for (const [t, aim] of this.aimTrail) if (t <= cutoff) before = aim;
    if (before === null || Math.abs(before - now) > LIFT_JITTER_TENTHS) return now;
    return before;
  }

  private readonly onUp = () => {
    if (this.picking && this.pickCol !== null) {
      const col = this.pickCol;
      this.options.onColumn?.(col);
      return;
    }
    if (!this.aiming) return;
    this.aiming = false;
    const aim = this.settledAim();
    this.aim = null;
    this.aimTrail = [];
    this.drawGuide();
    if (aim !== null && this.aimEnabled) {
      haptic(10);
      this.options.onFire(aim);
    }
  };

  private drawGuide(): void {
    this.guide.clear();
    if (!this.state || !this.stateJson) return;
    const dot = this.c.ballR * 0.42;
    const draw = (aim: number, color: number, alpha: number) => {
      const pts = engine.bbAimPath(this.stateJson, aim, 2);
      for (let i = 0; i + 3 < pts.length; i += 2) {
        const [x0, y0, x1, y1] = [(pts[i] ?? 0), (pts[i + 1] ?? 0), (pts[i + 2] ?? 0), (pts[i + 3] ?? 0)];
        const len = Math.hypot(x1 - x0, y1 - y0);
        const n = Math.floor(len / (this.c.cell * 0.26));
        for (let k = 1; k <= n; k++) {
          const t = k / n;
          const x = x0 + (x1 - x0) * t;
          const y = y0 + (y1 - y0) * t;
          this.guide.circle(x, y, dot * 2.2).fill({ color, alpha: alpha * 0.12 });
          this.guide.circle(x, y, dot).fill({ color, alpha });
        }
        // A ghost ball where the path bounces, like the key art.
        if (i + 2 < pts.length - 2) {
          this.guide.circle(x1, y1, this.c.ballR * 2).fill({ color, alpha: alpha * 0.15 });
          this.guide.circle(x1, y1, this.c.ballR).fill({ color, alpha: alpha * 0.9 });
        }
      }
    };
    if (this.hintAim !== null && this.aimEnabled) draw(this.hintAim, 0xfacc15, 0.55);
    if (this.aim !== null && this.aiming) draw(this.aim, 0xffffff, 0.8);
    this.drawHitMark(this.aiming ? this.aim : null);
  }

  /** Outlines the block the shot at `aim` hits first (the engine's own contact rule). */
  private drawHitMark(aim: number | null): void {
    const g = this.hitMark.clear();
    if (aim === null || !this.state || !this.stateJson) return;
    const [row, col] = Array.from(engine.bbAimHit(this.stateJson, aim));
    if (row === undefined || col === undefined) return;
    const cell = this.state.grid[row]?.[col];
    if (cell?.t !== "block") return;
    const { cell: size, blockInset } = this.c;
    const x0 = col * size;
    const y0 = row * size;
    const a = blockInset;
    const b = size - blockInset;
    const pts: Record<string, number[]> = {
      square: [a, a, b, a, b, b, a, b],
      tri_bl: [a, b, a, a, b, b],
      tri_br: [b, b, a, b, b, a],
      tri_tl: [a, a, b, a, a, b],
      tri_tr: [b, a, b, b, a, a],
    };
    const poly = (pts[cell.shape] ?? pts.square ?? []).map((v, i) => v + (i % 2 ? y0 : x0));
    g.poly(poly).fill({ color: 0xffffff, alpha: 0.28 }).stroke({ width: size * 0.07, color: 0xffffff });
  }

  // --------------------------------------------------------------- effects

  /** Returns true if any cell changed. `lone`: only one ball left in play. */
  private handleEvents(ev: Int32Array, lone = false): boolean {
    let changed = false;
    for (let i = 0; i + 2 < ev.length; i += 3) {
      const kind = (ev[i] ?? 0);
      const a = (ev[i + 1] ?? 0);
      const b = (ev[i + 2] ?? 0);
      switch (kind) {
        case 0:
          changed = true;
          sfx.hit(b);
          break;
        case 1:
          changed = true;
          this.combo += 1;
          sfx.blast(this.combo);
          haptic(8);
          this.burst(a);
          this.countBlast(lone);
          break;
        case 2:
          changed = true;
          sfx.laser();
          this.beam(a, b);
          if (!this.shot.laser) {
            this.shot.laser = true;
            this.shot.powers += 1;
            this.announce("Electric shock!", 0x7dd3fc);
          }
          break;
        case 3:
          sfx.pickup();
          if (!this.shot.scatter) {
            this.shot.scatter = true;
            this.shot.powers += 1;
            this.announce("Scatter!", 0xc084fc);
          }
          break;
        case 4:
          changed = true;
          sfx.pickup();
          this.shot.powers += 1;
          this.floatText(a, `+${b}`);
          break;
        case 6:
          changed = true;
          sfx.pickup();
          this.shot.powers += 1;
          this.floatText(a, `${b}× next`);
          this.announce(`Boost ${b}×! Next shot`, 0x4ade80);
          break;
        case 5:
          this.launchX = a;
          break;
      }
    }
    return changed;
  }

  private cellCenter(index: number): { x: number; y: number } {
    const { cols, cell } = this.c;
    return { x: (index % cols) * cell + cell / 2, y: Math.floor(index / cols) * cell + cell / 2 };
  }

  /** A block breaking: a bright flash and spinning shards that fall away. */
  private burst(index: number): void {
    if (prefersReducedMotion()) return;
    const { x, y } = this.cellCenter(index);
    const color = this.cells[index]?.color ?? 0xffffff;
    const cell = this.c.cell;

    const flash = new Sprite(this.glowTexture);
    flash.anchor.set(0.5);
    flash.position.set(x, y);
    flash.tint = 0xfff3c4;
    flash.blendMode = "add";
    this.fx.addChild(flash);
    void tween(this.app, 420, (t) => {
      flash.width = flash.height = cell * (0.8 + t * 3.2);
      flash.alpha = 1 - t * t;
    }).then(() => flash.destroy());

    const palette = [color, color, color, 0xfacc15, 0x22c55e, 0x38bdf8, 0xf97316];
    for (let i = 0; i < 18; i++) {
      const r = cell * (0.09 + Math.random() * 0.11);
      const shard = new Graphics()
        .poly([0, -r, r * 0.9, r * 0.7, -r * 0.8, r * 0.5])
        .fill(palette[i % palette.length] ?? color);
      shard.position.set(x, y);
      this.fx.addChild(shard);
      const angle = Math.random() * Math.PI * 2;
      const speed = cell * (0.8 + Math.random() * 1.1);
      const spin = (Math.random() - 0.5) * 12;
      void tween(this.app, 900, (t) => {
        shard.position.set(
          x + Math.cos(angle) * speed * t,
          y + Math.sin(angle) * speed * t + cell * 1.4 * t * t,
        );
        shard.rotation = spin * t;
        shard.alpha = 1 - t * t;
      }, (t) => t).then(() => shard.destroy());
    }
  }

  private beam(index: number, kind: number): void {
    const { cols, cell, boardW, playRows } = this.c;
    const col = index % cols;
    const row = Math.floor(index / cols);
    const g = new Graphics();
    g.blendMode = "add";
    const beamAt = (horizontal: boolean) => {
      for (const [w, color, alpha] of [[cell * 0.5, 0xf43f5e, 0.25], [cell * 0.18, 0xfda4af, 0.8], [cell * 0.05, 0xffffff, 1]] as const) {
        if (horizontal) g.rect(0, row * cell + cell / 2 - w / 2, boardW, w).fill({ color, alpha });
        else g.rect(col * cell + cell / 2 - w / 2, 0, w, playRows * cell).fill({ color, alpha });
      }
    };
    if (kind === 0 || kind === 2) beamAt(true);
    if (kind === 1 || kind === 2) beamAt(false);
    this.fx.addChild(g);
    void tween(this.app, 220, (t) => {
      g.alpha = 1 - t;
    }).then(() => g.destroy());
  }

  /** Tracks breaks in this shot: bursts close together are a multi-break. */
  private countBlast(lone: boolean): void {
    const s = this.shot;
    s.blasts += 1;
    s.recent = s.recent.filter((t) => this.tick - t < this.c.ticksPerSecond / 2);
    s.recent.push(this.tick);
    if (s.recent.length === 6) this.announce("Mega break!", 0xf472b6);
    else if (s.recent.length === 3) this.announce("Multi break!", 0xfbbf24);
    if (lone && !s.lastBall) {
      s.lastBall = true;
      this.announce("Last ball standing!", 0xe2e8f0);
    }
  }

  /** End-of-shot praise. */
  private summarise(): void {
    const s = this.shot;
    if (s.powers >= 2) this.announce("Good use of power!", 0x86efac);
    else if (s.blasts >= 15) this.announce("Unbelievable!", 0xf0abfc);
    else if (s.blasts >= 8) this.announce("Great shot!", 0x93c5fd);
    else if (s.blasts >= 4) this.announce("Good shot!", 0xfde68a);
  }

  /** A big message over the board that pops in and fades; spaced out so they never stack. */
  announce(text: string, color: number): void {
    if (this.destroyed) return;
    const now = performance.now();
    const delay = Math.max(0, this.lastAnnounce + ANNOUNCE_GAP_MS - now);
    this.lastAnnounce = now + delay;
    window.setTimeout(() => {
      if (this.destroyed) return;
      const { boardW, cell, floorY } = this.c;
      const t = this.makeText(text, cell * 0.62, color, true);
      t.position.set(boardW / 2, floorY * 0.42);
      this.fx.addChild(t);
      const base = t.scale.x; // makeText's 1/scale; the pop is relative to it
      const still = prefersReducedMotion();
      void tween(this.app, still ? 900 : 1100, (p) => {
        const pop = still ? 1 : p < 0.15 ? 0.6 + (p / 0.15) * 0.5 : 1.1 - Math.min(0.1, (p - 0.15) * 0.4);
        t.scale.set(base * pop);
        t.alpha = p < 0.7 ? 1 : 1 - (p - 0.7) / 0.3;
        if (!still) t.y = floorY * 0.42 - p * cell * 0.5;
      }).then(() => t.destroy());
    }, delay);
  }

  private drawPicker(): void {
    const g = this.picker;
    g.clear();
    if (!this.picking) return;
    const { cols, cell, floorY } = this.c;
    for (let c = 0; c < cols; c++) {
      const on = c === this.pickCol;
      g.rect(c * cell + cell * 0.08, 0, cell * 0.84, floorY).fill({ color: on ? 0x7dd3fc : 0xffffff, alpha: on ? 0.28 : 0.05 });
    }
  }

  private colFrom(e: FederatedPointerEvent): number {
    const x = (e.global.x - this.board.x) / this.scale;
    return Math.max(0, Math.min(this.c.cols - 1, Math.floor(x / this.c.cell)));
  }

  private floatText(index: number, text: string): void {
    const { x, y } = this.cellCenter(index);
    const t = this.makeText(text, this.c.cell * 0.4, 0xfacc15);
    t.position.set(x, y);
    this.fx.addChild(t);
    void tween(this.app, 700, (p) => {
      t.y = y - p * this.c.cell;
      t.alpha = 1 - p;
    }).then(() => t.destroy());
  }
}

/** Balls the next shot launches, boosts and paid bonus balls included (matches the engine). */
export function launchCount(state: BbState): number {
  return state.balls * (state.boost ?? 1) + (state.bonus ?? 0);
}

/** True when any block sits in the last row before the ground. */
function dangerRow(cells: Int32Array, cols: number, playRows: number): boolean {
  const row = playRows - 1;
  for (let c = 0; c < cols; c++) if (cells[(row * cols + c) * 3] === 1) return true;
  return false;
}
