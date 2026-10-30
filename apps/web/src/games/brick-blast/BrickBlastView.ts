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
const POWER_GLYPH = ["↔", "↕", "✚", "×3", "×5", "+2", "+3", "+5"];
const POWER_COLOR = [0xf43f5e, 0xf43f5e, 0xf43f5e, 0x38bdf8, 0x38bdf8, 0xfacc15, 0xfacc15, 0xfacc15];
const MAX_STEPS_PER_FRAME = 48;

export interface BrickBlastViewOptions {
  onFire: (aim: number) => void;
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
  private readonly cellLayer = new Container();
  private readonly guide = new Graphics();
  private readonly fx = new Container();
  private readonly ballLayer = new Container();
  private readonly launcher = new Graphics();
  private readonly ballCount: Text;
  private readonly ballTexture: Texture;
  private readonly ballPool: Sprite[] = [];
  private cells: CellView[] = [];
  private scale = 1;
  private state: BbState | null = null;
  private stateJson = "";
  private launchX = 0;
  private aimEnabled = false;
  private aiming = false;
  private aim: number | null = null;
  private hintAim: number | null = null;
  private speed = 1;
  private skipping = false;
  private combo = 0;
  private pulse = 0;
  private destroyed = false;

  private constructor(
    private readonly app: Application,
    private readonly options: BrickBlastViewOptions,
  ) {
    this.ballTexture = app.renderer.generateTexture(
      new Graphics().circle(0, 0, 32).fill(0xffffff),
    );
    this.ballCount = new Text({
      text: "",
      style: { fontSize: 14, fill: 0xe8ecff, fontWeight: "700" },
    });
    this.ballCount.anchor.set(0.5, 0);
    this.board.addChild(
      this.frame,
      this.cellLayer,
      this.guide,
      this.fx,
      this.ballLayer,
      this.launcher,
      this.ballCount,
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
    this.app.destroy({ removeView: true }, { children: true });
  }

  /** Shows a settled board (between turns). */
  setState(state: BbState): void {
    this.state = state;
    this.stateJson = JSON.stringify(state);
    this.launchX = state.launch_x;
    this.renderCells(engine.bbCells(this.stateJson));
    this.renderBalls(new Int32Array(0));
    this.drawLauncher(state.balls);
    this.drawGuide();
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
          if (this.skipping) continue;
          changed = this.handleEvents(turn.takeEvents()) || changed;
        }
        if (this.skipping) turn.takeEvents();
        if (changed || this.skipping) this.renderCells(turn.cells());
        this.renderBalls(turn.isDone() ? new Int32Array(0) : turn.balls());
        this.drawLauncher(turn.waiting());
        if (turn.isDone()) {
          this.app.ticker.remove(frame);
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
        node.addChild(
          new Graphics()
            .circle(0, 0, powerR)
            .fill({ color, alpha: 0.18 })
            .stroke({ width: cell * 0.05, color }),
        );
        node.addChild(this.makeText(POWER_GLYPH[kind] ?? "?", cell * 0.3, color));
        node.position.set(x0 + cell / 2, y0 + cell / 2);
        node.label = "power";
        this.cellLayer.addChild(node);
        view.node = node;
      }
    }
  }

  private readonly animatePowerUps = () => {
    this.pulse += this.app.ticker.deltaMS / 1000;
    const s = 1 + Math.sin(this.pulse * 4) * 0.06;
    for (const v of this.cells) {
      if (v.node?.label === "power") v.node.scale.set(s);
    }
  };

  // ----------------------------------------------------------------- balls

  private renderBalls(flat: Int32Array): void {
    const count = flat.length / 4;
    const size = (this.c.ballR * 2) / 64;
    while (this.ballPool.length < count) {
      const s = new Sprite(this.ballTexture);
      s.anchor.set(0.5);
      s.scale.set(size);
      this.ballLayer.addChild(s);
      this.ballPool.push(s);
    }
    for (let i = 0; i < this.ballPool.length; i++) {
      const s = this.ballPool[i];
      if (!s) continue;
      if (i >= count) {
        s.visible = false;
        continue;
      }
      s.visible = true;
      s.position.set((flat[i * 4 + 1] ?? 0), (flat[i * 4 + 2] ?? 0));
      s.tint = flat[i * 4 + 3] ? 0x7dd3fc : 0xffffff;
    }
  }

  private drawLauncher(waiting: number): void {
    const { floorY, ballR } = this.c;
    this.launcher.clear();
    if (waiting > 0) {
      this.launcher.circle(this.launchX, floorY - ballR - 1, ballR).fill(0xffffff);
    }
    this.ballCount.text = waiting > 0 ? `×${waiting}` : "";
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
    if (!this.aimEnabled) return;
    this.aiming = true;
    this.aim = this.aimFrom(e);
    this.drawGuide();
  };

  private readonly onMove = (e: FederatedPointerEvent) => {
    if (!this.aiming) return;
    const next = this.aimFrom(e);
    if (next !== this.aim) {
      this.aim = next;
      this.drawGuide();
    }
  };

  private readonly onUp = () => {
    if (!this.aiming) return;
    this.aiming = false;
    const aim = this.aim;
    this.aim = null;
    this.drawGuide();
    if (aim !== null && this.aimEnabled) {
      haptic(10);
      this.options.onFire(aim);
    }
  };

  private drawGuide(): void {
    this.guide.clear();
    if (!this.state || !this.stateJson) return;
    const dot = this.c.ballR * 0.45;
    const draw = (aim: number, color: number, alpha: number) => {
      const pts = engine.bbAimPath(this.stateJson, aim, 2);
      for (let i = 0; i + 3 < pts.length; i += 2) {
        const [x0, y0, x1, y1] = [(pts[i] ?? 0), (pts[i + 1] ?? 0), (pts[i + 2] ?? 0), (pts[i + 3] ?? 0)];
        const len = Math.hypot(x1 - x0, y1 - y0);
        const n = Math.floor(len / (this.c.cell * 0.32));
        for (let k = 1; k <= n; k++) {
          const t = k / n;
          this.guide.circle(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, dot).fill({ color, alpha });
        }
      }
    };
    if (this.hintAim !== null && this.aimEnabled) draw(this.hintAim, 0xfacc15, 0.55);
    if (this.aim !== null && this.aiming) draw(this.aim, 0xffffff, 0.8);
  }

  // --------------------------------------------------------------- effects

  /** Returns true if any cell changed. */
  private handleEvents(ev: Int32Array): boolean {
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
          break;
        case 2:
          changed = true;
          sfx.laser();
          this.beam(a, b);
          break;
        case 3:
          sfx.pickup();
          break;
        case 4:
          changed = true;
          sfx.pickup();
          this.floatText(a, `+${b}`);
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

  private burst(index: number): void {
    if (prefersReducedMotion()) return;
    const { x, y } = this.cellCenter(index);
    const color = this.cells[index]?.color ?? 0xffffff;
    const cell = this.c.cell;
    for (let i = 0; i < 8; i++) {
      const p = new Graphics().rect(-cell * 0.06, -cell * 0.06, cell * 0.12, cell * 0.12).fill(color);
      p.position.set(x, y);
      this.fx.addChild(p);
      const angle = (i / 8) * Math.PI * 2 + Math.random();
      const dist = cell * (0.6 + Math.random() * 0.5);
      void tween(this.app, 380, (t) => {
        p.position.set(x + Math.cos(angle) * dist * t, y + Math.sin(angle) * dist * t);
        p.alpha = 1 - t;
        p.rotation = t * 4;
      }).then(() => p.destroy());
    }
  }

  private beam(index: number, kind: number): void {
    const { cols, cell, boardW, playRows } = this.c;
    const col = index % cols;
    const row = Math.floor(index / cols);
    const g = new Graphics();
    const w = cell * 0.18;
    if (kind === 0 || kind === 2) g.rect(0, row * cell + cell / 2 - w / 2, boardW, w).fill(0xfda4af);
    if (kind === 1 || kind === 2) g.rect(col * cell + cell / 2 - w / 2, 0, w, playRows * cell).fill(0xfda4af);
    this.fx.addChild(g);
    void tween(this.app, 220, (t) => {
      g.alpha = 1 - t;
    }).then(() => g.destroy());
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
