/**
 * NeonCoil rules (decisions 2026-11-18/19): played on the device, just for fun.
 * A level is an arena (see levels.ts); eat 5 fruit to clear it. Walls and the
 * snake's own body end the attempt (try again at once). Stars reward short routes:
 * every fruit adds its shortest distance to a "par", and the moves taken are
 * compared with it.
 *
 * Turns are buffered two ahead, so a quick double swipe makes a U-turn without the
 * second swipe being lost or reversing into the neck.
 */
import { FRUIT_PER_LEVEL, startBody } from "./levels";

/** The default board (phones in portrait use about this). */
export const COLS = 19;
export const ROWS = 25;
/** The short side, and the limits on the long side. */
export const SHORT_SIDE = 19;
const LONG_MIN = 19;
const LONG_MAX = 34;
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

/** A board shaped like a `width` x `height` area: 19 cells on its short side. */
export function boardFor(width: number, height: number): { cols: number; rows: number } {
  if (width <= 0 || height <= 0) return { cols: COLS, rows: ROWS };
  const long = (a: number, b: number) => Math.min(LONG_MAX, Math.max(LONG_MIN, Math.floor((SHORT_SIDE * a) / b)));
  return width <= height ? { cols: SHORT_SIDE, rows: long(height, width) } : { cols: long(width, height), rows: SHORT_SIDE };
}

/** What one step did, for sounds and effects. */
export interface StepEvent {
  ate?: Cell;
  died?: "wall" | "self";
  cleared?: boolean;
}

/** Shortest number of moves from `a` to `b` around the walls (ignores the body). */
export function distance(a: Cell, b: Cell, cols: number, rows: number, blocked: Set<number>): number {
  const key = (x: number, y: number) => y * cols + x;
  const seen = new Set([key(a.x, a.y)]);
  let frontier = [a];
  for (let d = 0; frontier.length; d++) {
    const next: Cell[] = [];
    for (const p of frontier) {
      if (p.x === b.x && p.y === b.y) return d;
      for (const v of Object.values(DIRS)) {
        const x = p.x + v.x;
        const y = p.y + v.y;
        const k = key(x, y);
        if (x < 0 || y < 0 || x >= cols || y >= rows || blocked.has(k) || seen.has(k)) continue;
        seen.add(k);
        next.push({ x, y });
      }
    }
    frontier = next;
  }
  return Infinity;
}

export class Snake {
  /** Head first. */
  body: Cell[];
  dir: Dir = "up";
  private queue: Dir[] = [];
  fruit: Cell;
  eaten = 0;
  moves = 0;
  /** Sum of the shortest routes to each fruit so far. */
  par = 0;
  alive = true;
  cleared = false;
  readonly walls: Set<number>;
  private grow = 0;

  constructor(
    readonly cols = COLS,
    readonly rows = ROWS,
    walls: Cell[] = [],
    readonly goal = FRUIT_PER_LEVEL,
    private readonly random: () => number = Math.random,
  ) {
    this.walls = new Set(walls.map((w) => w.y * cols + w.x));
    this.body = startBody(cols, rows);
    this.fruit = this.spawn();
  }

  isWall(x: number, y: number): boolean {
    return this.walls.has(y * this.cols + x);
  }

  /** Queues a turn: up to two ahead, never a reversal into the neck. */
  turn(next: Dir): void {
    if (!this.alive || this.cleared) return;
    const last = this.queue[this.queue.length - 1] ?? this.dir;
    if (next === last || opposite(next, last) || this.queue.length >= BUFFER) return;
    this.queue.push(next);
  }

  /** 3 stars for near-shortest routes, 2 for reasonable ones, 1 for clearing. */
  stars(): number {
    const slack = 2 * this.goal;
    if (this.moves <= Math.ceil(this.par * 1.3) + slack) return 3;
    if (this.moves <= this.par * 2 + slack) return 2;
    return 1;
  }

  private spawn(): Cell {
    const free: Cell[] = [];
    const head = this.body[0] ?? { x: 0, y: 0 };
    for (let y = 0; y < this.rows; y++) {
      for (let x = 0; x < this.cols; x++) {
        if (this.isWall(x, y) || this.body.some((b) => b.x === x && b.y === y)) continue;
        // Not right in front of the head: a fruit should take a moment to reach.
        if (Math.abs(x - head.x) + Math.abs(y - head.y) < 3) continue;
        free.push({ x, y });
      }
    }
    const at = free[Math.floor(this.random() * free.length)] ?? { x: 0, y: 0 };
    const d = distance(head, at, this.cols, this.rows, this.walls);
    this.par += Number.isFinite(d) ? d : 0;
    return at;
  }

  /** Moves one cell. */
  step(): StepEvent {
    const event: StepEvent = {};
    if (!this.alive || this.cleared) return event;
    this.dir = this.queue.shift() ?? this.dir;
    const head = this.body[0] ?? { x: 0, y: 0 };
    const next = { x: head.x + DIRS[this.dir].x, y: head.y + DIRS[this.dir].y };
    this.moves += 1;
    if (next.x < 0 || next.y < 0 || next.x >= this.cols || next.y >= this.rows || this.isWall(next.x, next.y)) {
      this.alive = false;
      event.died = "wall";
      return event;
    }
    // The tail moves out of the way this step, unless the snake is growing.
    const tailLeaves = this.grow === 0;
    const hits = this.body.some(
      (b, i) => b.x === next.x && b.y === next.y && !(tailLeaves && i === this.body.length - 1),
    );
    if (hits) {
      this.alive = false;
      event.died = "self";
      return event;
    }
    this.body.unshift(next);
    if (this.grow > 0) this.grow -= 1;
    else this.body.pop();

    if (next.x === this.fruit.x && next.y === this.fruit.y) {
      event.ate = this.fruit;
      this.eaten += 1;
      this.grow += 1;
      if (this.eaten >= this.goal) {
        this.cleared = true;
        event.cleared = true;
      } else {
        this.fruit = this.spawn();
      }
    }
    return event;
  }
}
