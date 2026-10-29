import { useSyncExternalStore } from "react";

/** Per-device preferences. Cosmetic only, so local storage is fine. */
export interface Settings {
  sound: boolean;
  haptics: boolean;
  colorSymbols: boolean;
}

const KEY = "arc.settings";
const DEFAULTS: Settings = { sound: true, haptics: true, colorSymbols: false };

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Settings>) };
  } catch {
    // ignore corrupt or unavailable storage
  }
  return DEFAULTS;
}

let current = load();
const listeners = new Set<() => void>();

export function getSettings(): Settings {
  return current;
}

export function updateSettings(patch: Partial<Settings>): void {
  current = { ...current, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    // ignore
  }
  listeners.forEach((l) => l());
}

export function useSettings(): Settings {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    getSettings,
    getSettings,
  );
}
