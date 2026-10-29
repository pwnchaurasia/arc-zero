import { describe, expect, it } from "vitest";

import { hpColor, water, WATER } from "./colors";

describe("hpColor", () => {
  it("anchors at the documented stops", () => {
    expect(hpColor(1)).toBe(0x22c55e);
    expect(hpColor(150)).toBe(0xef4444);
    expect(hpColor(999)).toBe(0xef4444);
  });

  it("changes as HP drops", () => {
    expect(hpColor(100)).not.toBe(hpColor(20));
  });
});

describe("water", () => {
  it("covers every engine colour with a distinct symbol", () => {
    const symbols = new Set(WATER.map((w) => w.symbol));
    expect(symbols.size).toBe(WATER.length);
    expect(water(WATER.length)).toBe(WATER[0]);
  });
});
