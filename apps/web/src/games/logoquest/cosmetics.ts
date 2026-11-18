/**
 * LogoQuest skins and trails (decision 2026-11-18): unlocked by learning, never bought.
 * Each one opens at a milestone the server already knows (Tests passed, stars earned),
 * so there is nothing new to store or fake. The choice is a per-device preference.
 */

export type SkinId = "turtle" | "ladybug" | "racecar" | "rocket" | "hero" | "ufo" | "king";
export type TrailId = "plain" | "rainbow" | "sparkle" | "comet";

/** Stage -> stars, as the session reports it (Learn N = 2N - 1, Test N = 2N). */
export type Stars = Record<string, number>;

interface Unlock {
  /** Shown on locked items. */
  needs: string;
  test: (stars: Stars) => boolean;
}

const testPassed = (stars: Stars, level: number) => (stars[String(2 * level)] ?? 0) > 0;
const chapterDone = (stars: Stars, chapter: number) =>
  Array.from({ length: 20 }, (_, i) => (chapter - 1) * 20 + i + 1).every((l) => testPassed(stars, l));
const totalStars = (stars: Stars) => Object.values(stars).reduce((a, b) => a + b, 0);

export const SKINS: ({ id: SkinId; name: string } & Unlock)[] = [
  { id: "turtle", name: "Turtle", needs: "", test: () => true },
  { id: "ladybug", name: "Ladybug", needs: "Pass Test 5", test: (s) => testPassed(s, 5) },
  { id: "racecar", name: "Race car", needs: "Pass every Grid Walker Test", test: (s) => chapterDone(s, 1) },
  { id: "rocket", name: "Rocket", needs: "Pass every Pen & Paint Test", test: (s) => chapterDone(s, 2) },
  { id: "hero", name: "Superhero", needs: "Pass every Angle Explorer Test", test: (s) => chapterDone(s, 3) },
  { id: "ufo", name: "UFO", needs: "Pass every Loop Master Test", test: (s) => chapterDone(s, 4) },
  { id: "king", name: "King Turtle", needs: "Pass every Spirograph Lab Test", test: (s) => chapterDone(s, 5) },
];

export const TRAILS: ({ id: TrailId; name: string } & Unlock)[] = [
  { id: "plain", name: "Plain", needs: "", test: () => true },
  { id: "rainbow", name: "Rainbow", needs: "Earn 25 stars", test: (s) => totalStars(s) >= 25 },
  { id: "sparkle", name: "Sparkles", needs: "Earn 75 stars", test: (s) => totalStars(s) >= 75 },
  { id: "comet", name: "Comet", needs: "Earn 150 stars", test: (s) => totalStars(s) >= 150 },
];

export function unlockedNames(stars: Stars): string[] {
  return [...SKINS, ...TRAILS].filter((x) => x.test(stars)).map((x) => x.name);
}

/** Names unlocked by going from `before` to `after` (for the "New!" message). */
export function newlyUnlocked(before: Stars, after: Stars): string[] {
  const had = new Set(unlockedNames(before));
  return unlockedNames(after).filter((n) => !had.has(n));
}

export interface Look {
  skin: SkinId;
  trail: TrailId;
}

const KEY = "arc.lq.look";
const DEFAULT: Look = { skin: "turtle", trail: "plain" };

/** The saved look, falling back to the defaults for anything not unlocked any more. */
export function loadLook(stars: Stars): Look {
  let saved: Partial<Look> = {};
  try {
    saved = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Look>;
  } catch {
    // ignore
  }
  const skin = SKINS.find((x) => x.id === saved.skin && x.test(stars))?.id ?? DEFAULT.skin;
  const trail = TRAILS.find((x) => x.id === saved.trail && x.test(stars))?.id ?? DEFAULT.trail;
  return { skin, trail };
}

export function saveLook(look: Look): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(look));
  } catch {
    // ignore
  }
}

/** Golf words for a block count against par. */
export function parWord(blocks: number, par: number): string {
  if (blocks < par) return `${par - blocks} under par!`;
  if (blocks === par) return "On par!";
  return `${blocks - par} over par`;
}
