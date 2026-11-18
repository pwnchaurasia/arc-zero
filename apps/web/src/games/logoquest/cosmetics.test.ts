import { describe, expect, it } from "vitest";

import { newlyUnlocked, parWord, unlockedNames, type Stars } from "./cosmetics";

/** Every stage of chapter 1 passed with 2 stars. */
const chapterOne = (): Stars =>
  Object.fromEntries(Array.from({ length: 40 }, (_, i) => [String(i + 1), 2]));

describe("unlocks come from learning", () => {
  it("starts with the turtle and a plain trail", () => {
    expect(unlockedNames({})).toEqual(["Turtle", "Plain"]);
  });

  it("opens the ladybug at Test 5 and the race car with chapter 1", () => {
    expect(unlockedNames({ "10": 1 })).toContain("Ladybug");
    const names = unlockedNames(chapterOne());
    expect(names).toContain("Race car");
    expect(names).toContain("Rainbow"); // 80 stars
    expect(names).toContain("Sparkles");
    expect(names).not.toContain("Rocket");
  });

  it("names what a pass just unlocked", () => {
    // 78 stars already (Sparkles is open); passing the last Test opens the race car.
    const before = { ...chapterOne(), "40": 0 };
    expect(newlyUnlocked(before, chapterOne())).toEqual(["Race car"]);
    expect(newlyUnlocked({ "1": 3 }, { "1": 3, "10": 3 })).toEqual(["Ladybug"]);
  });
});

describe("par", () => {
  it("talks golf", () => {
    expect([parWord(2, 3), parWord(3, 3), parWord(5, 3)]).toEqual(["1 under par!", "On par!", "2 over par"]);
  });
});
