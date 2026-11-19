/**
 * NeonCoil rules (decision 2026-11-18): an endless snake that gets faster as time
 * passes, played entirely on the device for fun (no levels, coins or server).
 *
 * The board is 19 cells across its short side and as long as the screen allows
 * (fixed when a run starts); walls and the snake's own body end the run. Apples are
 * worth 10, a golden fruit (every 5th apple, gone after 7 seconds) 50. Eating again
 * within 4 seconds raises the combo, up to 5x (FEVER), which multiplies the points.
 * Turns are buffered (two ahead), so a quick double swipe makes a U-turn without the
 * second swipe being lost or reversing into the neck.
 */

/** The default board (phones in portrait use about this). */
export const COLS = 19;
export const ROWS = 25;
/** The short side, and the limits on the long side. */
export const SHORT_SIDE = 19;
const LONG_MIN = 19;
const LONG_MAX = 34;

/** A board shaped like a `width` x `height` area: 19 cells on its short side. */
export function boardFor(width: number, height: number): { cols: number; rows: number } {
  if (width <= 0 || height <= 0) return { cols: COLS, rows: ROWS };
  const long = (a: number, b: number) => Math.min(LONG_MAX, Math.max(LONG_MIN, Math.floor((SHORT_SIDE * a) / b)));
  return width <= height ? { cols: SHORT_SIDE, rows: long(height, width) } : { cols: long(width, height), rows: SHORT_SIDE };
}
export const START_LENGTH = 4;
/** Milliseconds per cell at the start, and the fastest it gets. */
export const START_TICK_MS = 150;
export const MIN_TICK_MS = 62;
/** Every this many milliseconds the snake speeds up a step. */
export const SPEED_STEP_MS = 10_000;
const SPEED_FACTOR = 0.93;
export const COMBO_MS = 4_000;
export const MAX_COMBO = 5;
export const GOLDEN_EVERY = 5;
export const GOLDEN_MS = 7_000;
const APPLE_POINTS = 10;
const GOLDEN_POINTS = 50;
const BUFFER = 2;

export interface Cell {
  x: number;
  y: number;
}

export type Dir = "up" | "down" | "left" | "right";

export const DIRS: Record<Dir, Cell> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

const opposite = (a: Dir, b: Dir) => DIRS[a].x + DIRS[b].x === 0 && DIRS[a].y + DIRS[b].y === 0;

export interface Food extends Cell {
  golden: boolean;
  /** Golden fruit: when it disappears (game time, ms). */
  expires?: number;
}

/** What one step did, for sounds and effects. */
export interface StepEvent {
  ate?: { food: Food; points: number; combo: number };
  died?: "wall" | "self";
  /** The golden fruit timed out. */
  goldenGone?: Food;
  speedUp?: number;
}

/** Speed step (1, 2, ...) after `elapsed` ms of play. */
export const speedLevel = (elapsed: number) => Math.floor(elapsed / SPEED_STEP_MS) + 1;

/** Milliseconds per cell after `elapsed` ms of play. */
export function tickMs(elapsed: number): number {
  return Math.max(MIN_TICK_MS, START_TICK_MS * Math.pow(SPEED_FACTOR, speedLevel(elapsed) - 1));
}

export class Snake {
  /** Head first. */
  body: Cell[];
  dir: Dir = "up";
  private queue: Dir[] = [];
  apple: Food;
  golden: Food | null = null;
  score = 0;
  eaten = 0;
  combo = 1;
  /** Game time of the last bite (for the combo window). */
  lastBite = -Infinity;
  /** Game time: only the steps advance it, so pausing stops the clock. */
  elapsed = 0;
  alive = true;
  private grow = 0;

  constructor(
    private readonly random: () => number = Math.random,
    readonly cols = COLS,
    readonly rows = ROWS,
  ) {
    const x = Math.floor(cols / 2);
    const y = rows - 7;
    this.body = Array.from({ length: START_LENGTH }, (_, i) => ({ x, y: y + i }));
    this.apple = this.spawn(false);
  }

  /** Queues a turn: up to two ahead, never a reversal into the neck. */
  turn(next: Dir): void {
    if (!this.alive) return;
    const last = this.queue[this.queue.length - 1] ?? this.dir;
    if (next === last || opposite(next, last) || this.queue.length >= BUFFER) return;
    this.queue.push(next);
  }

  /** The combo ring: 1 just after a bite, 0 when the window has closed. */
  comboLeft(): number {
    return Math.max(0, 1 - (this.elapsed - this.lastBite) / COMBO_MS);
  }

  private occupied(c: Cell): boolean {
    return this.body.some((b) => b.x === c.x && b.y === c.y);
  }

  private spawn(golden: boolean): Food {
    const free: Cell[] = [];
    for (let y = 0; y < this.rows; y++) {
      for (let x = 0; x < this.cols; x++) {
        const c = { x, y };
        const taken =
          this.occupied(c) ||
          (this.apple && this.apple.x === x && this.apple.y === y) ||
          (this.golden && this.golden.x === x && this.golden.y === y);
        if (!taken) free.push(c);
      }
    }
    const at = free[Math.floor(this.random() * free.length)] ?? { x: 0, y: 0 };
    return { ...at, golden, expires: golden ? this.elapsed + GOLDEN_MS : undefined };
  }

  /** Moves one cell. `ms` is how long this step took (it advances the game clock). */
  step(ms: number): StepEvent {
    const event: StepEvent = {};
    if (!this.alive) return event;
    const speedBefore = speedLevel(this.elapsed);
    this.elapsed += ms;
    if (speedLevel(this.elapsed) > speedBefore && tickMs(this.elapsed) < tickMs(this.elapsed - ms)) {
      event.speedUp = speedLevel(this.elapsed);
    }
    this.dir = this.queue.shift() ?? this.dir;
    const head = this.body[0] ?? { x: 0, y: 0 };
    const next = { x: head.x + DIRS[this.dir].x, y: head.y + DIRS[this.dir].y };
    if (next.x < 0 || next.y < 0 || next.x >= this.cols || next.y >= this.rows) {
      this.alive = false;
      event.died = "wall";
      return event;
    }
    // The tail moves out of the way this step, unless the snake is growing.
    const tailLeaves = this.grow === 0;
    const hits = this.body.some((b, i) => b.x === next.x && b.y === next.y && !(tailLeaves && i === this.body.length - 1));
    if (hits) {
      this.alive = false;
      event.died = "self";
      return event;
    }
    this.body.unshift(next);
    if (this.grow > 0) this.grow -= 1;
    else this.body.pop();

    const bite = (food: Food, base: number) => {
      this.combo = this.elapsed - this.lastBite <= COMBO_MS ? Math.min(MAX_COMBO, this.combo + 1) : 1;
      this.lastBite = this.elapsed;
      const points = base * this.combo;
      this.score += points;
      this.grow += food.golden ? 2 : 1;
      event.ate = { food, points, combo: this.combo };
    };
    if (next.x === this.apple.x && next.y === this.apple.y) {
      const eatenApple = this.apple;
      this.eaten += 1;
      bite(eatenApple, APPLE_POINTS);
      this.apple = this.spawn(false);
      if (this.eaten % GOLDEN_EVERY === 0 && !this.golden) this.golden = this.spawn(true);
    } else if (this.golden && next.x === this.golden.x && next.y === this.golden.y) {
      const g = this.golden;
      this.golden = null;
      bite(g, GOLDEN_POINTS);
    }
    if (this.golden && (this.golden.expires ?? Infinity) <= this.elapsed) {
      event.goldenGone = this.golden;
      this.golden = null;
    }
    return event;
  }
}
