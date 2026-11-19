import { beforeEach, describe, expect, it } from "vitest";

import { chooseSkin, loadSaved, mix, newlyUnlocked, openLevel, recordClear, SKINS, totalStars } from "./skins";

// Tests run in Node: a small in-memory stand-in for the browser's storage.
const store = new Map<string, string>();
globalThis.localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: () => null,
  get length() {
    return store.size;
  },
} as Storage;

describe("progress and skins", () => {
  beforeEach(() => localStorage.clear());

  it("start at level 1 with only the first skin", () => {
    expect(loadSaved()).toEqual({ stars: {}, skin: "viper" });
    expect(openLevel(loadSaved())).toBe(1);
  });

  it("keep the best stars and open the next level", () => {
    recordClear(1, 2);
    recordClear(1, 1);
    recordClear(2, 3);
    const saved = loadSaved();
    expect(saved.stars).toEqual({ 1: 2, 2: 3 });
    expect(totalStars(saved)).toBe(5);
    expect(openLevel(saved)).toBe(3);
  });

  it("unlock skins with stars, and never keep a locked one", () => {
    expect(newlyUnlocked(8, 26).map((s) => s.id)).toEqual(["cobalt", "solar"]);
    expect(chooseSkin("aurora").skin).toBe("viper");
    for (let l = 1; l <= 4; l++) recordClear(l, 3);
    expect(chooseSkin("cobalt").skin).toBe("cobalt");
    expect(SKINS.map((s) => s.unlock)).toEqual([...SKINS.map((s) => s.unlock)].sort((a, b) => a - b));
  });

  it("ignore corrupt or tampered storage", () => {
    localStorage.setItem("arc.neoncoil.v2", "{nope");
    expect(loadSaved().stars).toEqual({});
    localStorage.setItem("arc.neoncoil.v2", JSON.stringify({ stars: { 1: 9, 99: 3, 2: 3 }, skin: "aurora" }));
    expect(loadSaved()).toEqual({ stars: { 2: 3 }, skin: "viper" });
  });

  it("mix colours", () => {
    expect(mix(0x000000, 0xffffff, 0.5)).toBe(0x808080);
    expect(mix(0xff0000, 0x0000ff, 1)).toBe(0x0000ff);
  });
});
