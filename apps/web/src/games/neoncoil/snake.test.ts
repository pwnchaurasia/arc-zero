import { describe, expect, it } from "vitest";

import { boardFor, COLS, MIN_TICK_MS, ROWS, Snake, START_LENGTH, START_TICK_MS, tickMs } from "./snake";

/** A snake whose food always lands on the first free cell scanned (top-left first). */
const predictable = () => new Snake(() => 0);
const headOf = (s: Snake) => s.body[0] ?? { x: -1, y: -1 };
/** Puts an apple right in front of a snake heading up. */
const appleAhead = (s: Snake) => ({ x: headOf(s).x, y: headOf(s).y - 1, golden: false });

describe("moving and turning", () => {
  it("starts in the lower middle, heading up", () => {
    const s = predictable();
    expect(s.body).toHaveLength(START_LENGTH);
    expect(s.body[0]).toEqual({ x: Math.floor(COLS / 2), y: ROWS - 7 });
    s.step(150);
    expect(s.body[0]).toEqual({ x: Math.floor(COLS / 2), y: ROWS - 8 });
  });

  it("buffers two turns and never reverses into the neck", () => {
    const s = predictable();
    s.turn("down"); // reversal: ignored
    s.turn("left");
    s.turn("down"); // a U-turn: left, then down
    s.turn("right"); // a third turn: no room in the buffer
    const head = { ...headOf(s) };
    s.step(150);
    expect(s.body[0]).toEqual({ x: head.x - 1, y: head.y });
    s.step(150);
    expect(s.body[0]).toEqual({ x: head.x - 1, y: head.y + 1 });
    expect(s.dir).toBe("down");
    expect(s.alive).toBe(true);
  });

  it("ends at a wall", () => {
    const s = predictable();
    let event = {};
    for (let i = 0; i < ROWS && s.alive; i++) event = s.step(150);
    expect(s.alive).toBe(false);
    expect(event).toMatchObject({ died: "wall" });
  });

  it("ends on its own body, but may move into the cell its tail is leaving", () => {
    const s = predictable();
    s.body = [{ x: 5, y: 5 }, { x: 5, y: 6 }, { x: 6, y: 6 }, { x: 6, y: 5 }];
    s.turn("right"); // into the tail's cell, which moves away: fine
    expect(s.step(150).died).toBeUndefined();
    s.body = [{ x: 5, y: 5 }, { x: 5, y: 6 }, { x: 6, y: 6 }, { x: 6, y: 5 }, { x: 7, y: 5 }];
    s.dir = "up";
    s.turn("right");
    expect(s.step(150).died).toBe("self");
  });
});

describe("eating, combos and golden fruit", () => {
  it("grows, scores, and raises the combo for quick bites", () => {
    const s = predictable();
    s.apple = appleAhead(s);
    const first = s.step(150);
    expect(first.ate).toMatchObject({ points: 10, combo: 1 });
    s.apple = appleAhead(s);
    const second = s.step(150);
    expect(second.ate).toMatchObject({ points: 20, combo: 2 });
    expect(s.score).toBe(30);
    s.step(150);
    expect(s.body).toHaveLength(START_LENGTH + 2);
  });

  it("drops the combo after 4 seconds without a bite", () => {
    const s = predictable();
    s.apple = appleAhead(s);
    s.step(150);
    s.step(4_000);
    s.apple = appleAhead(s);
    expect(s.step(150).ate?.combo).toBe(1);
  });

  it("brings a golden fruit every 5th apple, which times out", () => {
    const s = predictable();
    for (let i = 0; i < 5; i++) {
      s.apple = appleAhead(s);
      s.step(10);
      if (headOf(s).y < 3) s.body = s.body.map((c) => ({ ...c, y: c.y + 10 }));
    }
    expect(s.golden).not.toBeNull();
    let gone = false;
    for (let i = 0; i < 8 && !gone; i++) {
      s.body = s.body.map((c) => ({ ...c, y: Math.min(ROWS - 1, c.y + 1) }));
      gone = !!s.step(1_000).goldenGone;
    }
    expect(gone).toBe(true);
  });
});

describe("board shape", () => {
  it("keeps 19 cells on the short side and fills the long one", () => {
    expect(boardFor(390, 640)).toEqual({ cols: 19, rows: 31 });
    expect(boardFor(1200, 700)).toEqual({ cols: 32, rows: 19 });
    expect(boardFor(400, 400)).toEqual({ cols: 19, rows: 19 });
    expect(boardFor(300, 2000).rows).toBe(34);
  });

  it("plays on any board", () => {
    const s = new Snake(() => 0, 30, 19);
    expect(s.body[0]).toEqual({ x: 15, y: 12 });
    for (let i = 0; i < 13; i++) s.step(150);
    expect(s.alive).toBe(false);
  });
});

describe("speed", () => {
  it("gets faster every 10 seconds, down to a limit", () => {
    expect(tickMs(0)).toBe(START_TICK_MS);
    expect(tickMs(10_000)).toBeLessThan(START_TICK_MS);
    expect(tickMs(30 * 60_000)).toBe(MIN_TICK_MS);
  });
});
