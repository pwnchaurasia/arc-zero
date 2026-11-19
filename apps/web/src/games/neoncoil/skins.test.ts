import { beforeEach, describe, expect, it } from "vitest";

import { loadSaved, mix, newlyUnlocked, save, SKINS } from "./skins";

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

describe("skins", () => {
  beforeEach(() => localStorage.clear());

  it("start with only the first skin and a best of 0", () => {
    expect(loadSaved()).toEqual({ best: 0, skin: "viper" });
  });

  it("unlock as the best score grows", () => {
    expect(newlyUnlocked(100, 320).map((s) => s.id)).toEqual(["cobalt", "solar"]);
    expect(newlyUnlocked(320, 330)).toEqual([]);
    expect(SKINS.map((s) => s.unlock)).toEqual([...SKINS.map((s) => s.unlock)].sort((a, b) => a - b));
  });

  it("never keep a locked skin chosen, even if storage says so", () => {
    localStorage.setItem("arc.neoncoil", JSON.stringify({ best: 200, skin: "aurora" }));
    expect(loadSaved()).toEqual({ best: 200, skin: "viper" });
    save({ skin: "cobalt" });
    expect(loadSaved().skin).toBe("cobalt");
  });

  it("ignore corrupt storage", () => {
    localStorage.setItem("arc.neoncoil", "{nope");
    expect(loadSaved().best).toBe(0);
  });

  it("mix colours", () => {
    expect(mix(0x000000, 0xffffff, 0.5)).toBe(0x808080);
    expect(mix(0xff0000, 0x0000ff, 1)).toBe(0x0000ff);
  });
});
