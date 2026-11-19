import { describe, expect, it } from "vitest";

import { fruitGoal, LEVEL_COUNT, levelTick, levelWalls, startBody } from "./levels";
import { boardFor, type Cell, distance, Snake } from "./snake";

const headOf = (s: Snake) => s.body[0] ?? { x: -1, y: -1 };

describe("moving and turning", () => {
  it("starts in the lower middle, heading up", () => {
    const s = new Snake(19, 25);
    expect(s.body).toHaveLength(4);
    expect(headOf(s)).toEqual({ x: 9, y: 19 });
    s.step();
    expect(headOf(s)).toEqual({ x: 9, y: 18 });
  });

  it("buffers two turns and never reverses into the neck", () => {
    const s = new Snake(19, 25);
    s.turn("down"); // reversal: ignored
    s.turn("left");
    s.turn("down"); // a U-turn: left, then down
    s.turn("right"); // a third turn: no room in the buffer
    const head = { ...headOf(s) };
    s.step();
    expect(headOf(s)).toEqual({ x: head.x - 1, y: head.y });
    s.step();
    expect(headOf(s)).toEqual({ x: head.x - 1, y: head.y + 1 });
    expect(s.alive).toBe(true);
  });

  it("takes a turn pressed just after leaving a cell from that cell", () => {
    const s = new Snake(19, 25);
    s.step(); // straight up to (9, 18)
    const ev = s.lateTurn("left");
    expect(ev).toEqual({});
    expect(headOf(s)).toEqual({ x: 8, y: 19 });
    expect(s.moves).toBe(1);
    expect(s.body).toHaveLength(4);
    // Not twice, not backwards, not after a queued turn.
    expect(s.lateTurn("up")).toBeNull();
    s.step();
    expect(s.lateTurn("right")).toBeNull();
    s.turn("up");
    expect(s.lateTurn("down")).toBeNull();
  });

  it("ends at the edge, at a wall, and on its own body", () => {
    const edge = new Snake(19, 25);
    let event = {};
    for (let i = 0; i < 30 && edge.alive; i++) event = edge.step();
    expect(event).toMatchObject({ died: "wall" });

    const walled = new Snake(19, 25, [{ x: 9, y: 17 }]);
    walled.step();
    expect(walled.step().died).toBe("wall");

    const s = new Snake(19, 25);
    s.body = [{ x: 5, y: 5 }, { x: 5, y: 6 }, { x: 6, y: 6 }, { x: 6, y: 5 }, { x: 7, y: 5 }];
    s.turn("right");
    expect(s.step().died).toBe("self");
  });
});

describe("fruit, clearing and stars", () => {
  it("clears the level after its last fruit", () => {
    const s = new Snake(19, 25, [], 5);
    let last = {};
    for (let i = 0; i < 5; i++) {
      s.fruit = { x: headOf(s).x, y: headOf(s).y - 1 };
      last = s.step();
      if (headOf(s).y < 3) s.body = s.body.map((c) => ({ ...c, y: c.y + 10 }));
    }
    expect(last).toMatchObject({ cleared: true });
    expect(s.cleared).toBe(true);
    expect(s.body).toHaveLength(8);
    expect(s.step()).toEqual({}); // nothing moves once cleared
  });

  it("never puts fruit on a wall or the body", () => {
    for (let level = 1; level <= LEVEL_COUNT; level++) {
      const s = new Snake(19, 25, levelWalls(level, 19, 25));
      expect(s.isWall(s.fruit.x, s.fruit.y)).toBe(false);
      expect(s.body.some((b) => b.x === s.fruit.x && b.y === s.fruit.y)).toBe(false);
    }
  });

  it("gives 3 stars for short routes and fewer for wandering", () => {
    const s = new Snake(19, 25); // 20 fruit
    s.par = 200;
    s.moves = 270;
    expect(s.stars()).toBe(3);
    s.moves = 400;
    expect(s.stars()).toBe(2);
    s.moves = 500;
    expect(s.stars()).toBe(1);
  });

  it("measures routes around walls", () => {
    const walls = new Set([0, 1, 2].map((y) => y * 5 + 2));
    expect(distance({ x: 0, y: 0 }, { x: 4, y: 0 }, 5, 5, walls)).toBe(10);
  });
});

describe("levels", () => {
  const boards: [number, number][] = [
    [19, 25],
    [19, 31],
    [19, 34],
    [19, 19],
    [32, 19],
    [34, 19],
  ];

  it("last 20-25 fruit and speed up every 5 fruit, gently capped", () => {
    expect(fruitGoal(1)).toBe(20);
    expect(fruitGoal(LEVEL_COUNT)).toBe(25);
    expect(levelTick(1, 0)).toBe(150);
    expect(levelTick(1, 4)).toBe(150);
    expect(levelTick(1, 5)).toBeLessThan(150);
    expect(levelTick(1, 15)).toBeGreaterThan(110);
    expect(levelTick(2, 0)).toBeLessThan(150);
    expect(levelTick(LEVEL_COUNT, 24)).toBe(80);
  });

  it("start open, then every level has its own walls", () => {
    expect(levelWalls(1, 19, 25)).toEqual([]);
    const shapes = new Set<string>();
    for (let l = 2; l <= LEVEL_COUNT; l++) {
      const w = levelWalls(l, 19, 25);
      expect(w.length, `level ${l}`).toBeGreaterThan(0);
      shapes.add(JSON.stringify(w));
    }
    expect(shapes.size).toBe(LEVEL_COUNT - 1);
    expect(levelWalls(30, 19, 25).length).toBeGreaterThan(levelWalls(4, 19, 25).length);
  });

  it("keep the start lane open and every open cell reachable, on every board", () => {
    for (const [cols, rows] of boards) {
      for (let level = 1; level <= LEVEL_COUNT; level++) {
        const walls = levelWalls(level, cols, rows);
        const blocked = new Set(walls.map((w) => w.y * cols + w.x));
        const start = startBody(cols, rows);
        const head = start[0] as Cell;
        const lane = [...start, { x: head.x, y: head.y - 1 }, { x: head.x, y: head.y - 2 }, { x: head.x, y: head.y - 3 }];
        for (const p of lane) {
          expect(blocked.has(p.y * cols + p.x), `level ${level} ${cols}x${rows} lane`).toBe(false);
        }
        // A flood fill from the head reaches every open cell.
        const seen = new Set([head.y * cols + head.x]);
        const stack = [head];
        while (stack.length) {
          const p = stack.pop() as Cell;
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
            const x = p.x + dx;
            const y = p.y + dy;
            const k = y * cols + x;
            if (x < 0 || y < 0 || x >= cols || y >= rows || blocked.has(k) || seen.has(k)) continue;
            seen.add(k);
            stack.push({ x, y });
          }
        }
        expect(seen.size, `level ${level} on ${cols}x${rows} has closed-off cells`).toBe(cols * rows - blocked.size);
      }
    }
  });

  it("fit the screen shape", () => {
    expect(boardFor(390, 640)).toEqual({ cols: 19, rows: 31 });
    expect(boardFor(1200, 700)).toEqual({ cols: 32, rows: 19 });
  });
});
