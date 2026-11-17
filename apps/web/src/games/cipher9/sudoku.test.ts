import { describe, expect, it } from "vitest";

import {
  boxOf,
  candidates,
  clashes,
  clock,
  counts,
  explain,
  hasDigit,
  looksSolved,
  PEERS,
  unitCells,
} from "./sudoku";

const PUZZLE = "530070000600195000098000060800060003400803001700020006060000280000419005000080079";
const SOLUTION = "534678912672195348198342567859761423426853791713924856961537284287419635345286179";
const grid = (s: string) => [...s].map(Number);

describe("board geometry", () => {
  it("knows rows, columns, boxes and peers", () => {
    expect(unitCells("row", 0)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(unitCells("column", 0)).toEqual([0, 9, 18, 27, 36, 45, 54, 63, 72]);
    expect(unitCells("box", 4)).toEqual([30, 31, 32, 39, 40, 41, 48, 49, 50]);
    expect(boxOf(80)).toBe(8);
    expect(PEERS.every((p) => p.length === 20)).toBe(true);
  });
});

describe("clashes and candidates", () => {
  it("finds repeated numbers only", () => {
    const g = grid(PUZZLE);
    expect(clashes(g).size).toBe(0);
    g[2] = 5; // row 0 already has a 5 in cell 0
    expect([...clashes(g)].sort((a, b) => a - b)).toEqual([0, 2]);
  });

  it("lists what still fits", () => {
    const g = grid(PUZZLE);
    const mask = candidates(g, 2);
    expect(hasDigit(mask, 4)).toBe(true);
    expect(hasDigit(mask, 5)).toBe(false);
    expect(candidates(g, 0)).toBe(0); // a given
  });

  it("calls a full grid with no repeats solved", () => {
    expect(looksSolved(grid(SOLUTION))).toBe(true);
    expect(looksSolved(grid(PUZZLE))).toBe(false);
    expect(counts(grid(SOLUTION)).slice(1)).toEqual([9, 9, 9, 9, 9, 9, 9, 9, 9]);
  });
});

describe("hint text", () => {
  it("explains singles and honest reveals", () => {
    expect(
      explain({ cell: 2, digit: 4, technique: "hidden_single", unit_kind: "box", unit: 0, after: [] }),
    ).toBe("In box 1, 4 fits in only one cell: row 1, column 3.");
    expect(explain({ cell: 2, digit: 4, technique: "naked_single", unit_kind: null, unit: null, after: ["x_wing"] })).toBe(
      "First, an X-Wing crosses out some options. Then at row 1, column 3, every number but 4 is already used in its row, column or box.",
    );
    expect(explain({ cell: 2, digit: 4, technique: null, unit_kind: null, unit: null, after: [] })).toMatch(/reveals/);
  });

  it("formats the clock", () => {
    expect(clock(0)).toBe("0:00");
    expect(clock(75)).toBe("1:15");
    expect(clock(3725)).toBe("1:02:05");
  });
});
