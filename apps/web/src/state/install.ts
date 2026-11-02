import { useEffect, useState } from "react";

/** Chrome/Edge/Android's install event (not in the standard DOM types yet). */
interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

let deferred: InstallPromptEvent | null = null;
const listeners = new Set<() => void>();

// Captured as early as possible: the event fires once, often before React mounts.
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferred = e as InstallPromptEvent;
  listeners.forEach((l) => l());
});
window.addEventListener("appinstalled", () => {
  deferred = null;
  listeners.forEach((l) => l());
});

function isStandalone(): boolean {
  return (
    window.matchMedia?.("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

/** iPhone and iPad (iPadOS reports itself as a Mac with touch). Safari has no install prompt. */
function isIos(): boolean {
  const ua = navigator.userAgent;
  return /iPhone|iPad|iPod/.test(ua) || (ua.includes("Macintosh") && navigator.maxTouchPoints > 1);
}

export interface Install {
  /** "prompt": the browser can install; "ios": show the Add to Home Screen guide; null: nothing to offer. */
  mode: "prompt" | "ios" | null;
  install: () => Promise<void>;
}

export function useInstall(): Install {
  const [, bump] = useState(0);
  useEffect(() => {
    const l = () => bump((n) => n + 1);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);

  const mode = isStandalone() ? null : deferred ? "prompt" : isIos() ? "ios" : null;
  return {
    mode,
    install: async () => {
      const e = deferred;
      if (!e) return;
      await e.prompt();
      await e.userChoice;
      deferred = null;
      listeners.forEach((l) => l());
    },
  };
}
