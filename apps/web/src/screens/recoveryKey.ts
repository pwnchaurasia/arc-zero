/** Helpers for showing a recovery key once and making sure the player really saved it. */

export function keyWords(key: string): string[] {
  return key.split("-").filter(Boolean);
}

/** True when `typed` is the word at `index` (0-based), ignoring case and spaces. */
export function wordMatches(words: string[], index: number, typed: string): boolean {
  const want = words[index];
  return want !== undefined && typed.trim().toLowerCase() === want.toLowerCase();
}

/** Text of the downloadable key file. */
export function keyFileText(key: string, site: string): string {
  return [
    "Arc Zero recovery key",
    "",
    keyWords(key).join(" "),
    "",
    `Restores your progress on any device: ${site} → Settings → "I have a key".`,
    "Keep it private: anyone with this key can use your progress.",
    "",
  ].join("\n");
}
