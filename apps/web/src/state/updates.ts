import { registerSW } from "virtual:pwa-register";

/** Look for a new version this often while the app stays open. */
const CHECK_EVERY_MS = 30 * 60 * 1000;

let apply: ((reload: boolean) => Promise<void>) | null = null;
let waiting = false;
let atHome = false;

function applyIfSafe(): void {
  if (waiting && atHome && apply) {
    waiting = false;
    void apply(true);
  }
}

/**
 * Keeps installed and open copies of the app up to date. The browser checks for a
 * new version when the app opens, comes back to the front, and every half hour;
 * a new version is switched in (with a reload) only on the home screen.
 */
export function startUpdates(): void {
  if (!("serviceWorker" in navigator)) return;
  apply = registerSW({
    onNeedRefresh() {
      waiting = true;
      applyIfSafe();
    },
    onRegisteredSW(_url, registration) {
      if (!registration) return;
      const check = () => {
        if (navigator.onLine) void registration.update().catch(() => undefined);
      };
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") check();
      });
      setInterval(check, CHECK_EVERY_MS);
    },
  });
}

/** The app tells us whether the home screen is showing (the only safe place to reload). */
export function setAtHome(home: boolean): void {
  atHome = home;
  applyIfSafe();
}
