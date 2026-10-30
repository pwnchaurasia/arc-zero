import { describe, expect, it } from "vitest";

import { hpColor, shade, water, WATER } from "./colors";

describe("hpColor", () => {
  it("anchors at the documented stops", () => {
    expect(hpColor(1)).toBe(0xfacc15);
    expect(hpColor(50)).toBe(0x22c55e);
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

describe("shade", () => {
  it("lightens towards white and darkens towards black", () => {
    expect(shade(0x808080, 1)).toBe(0xffffff);
    expect(shade(0x808080, -1)).toBe(0x000000);
    expect(shade(0x808080, 0)).toBe(0x808080);
    expect(shade(0x000000, 0.5)).toBe(0x808080);
  });
});
