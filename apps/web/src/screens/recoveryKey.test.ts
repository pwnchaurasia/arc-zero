import { describe, expect, it } from "vitest";

import { keyFileName, keyFileText, keyWords, wordMatches } from "./recoveryKey";

const KEY = "amber-falcon-river-pixel-frost-canyon";

describe("recovery key confirmation", () => {
  it("accepts only the asked word, ignoring case and spaces", () => {
    const words = keyWords(KEY);
    expect(words).toHaveLength(6);
    expect(wordMatches(words, 3, "pixel")).toBe(true);
    expect(wordMatches(words, 3, "  PIXEL ")).toBe(true);
    expect(wordMatches(words, 3, "river")).toBe(false);
    expect(wordMatches(words, 3, "")).toBe(false);
    expect(wordMatches(words, 9, "pixel")).toBe(false);
  });

  it("writes every word into the download", () => {
    const text = keyFileText(KEY, "https://play.example.com", "Some Arcade");
    expect(text).toContain("amber falcon river pixel frost canyon");
    expect(text).toContain("https://play.example.com");
    expect(text.startsWith("Some Arcade recovery key")).toBe(true);
    expect(keyFileName("Some Arcade")).toBe("some-arcade-recovery-key.txt");
  });
});
