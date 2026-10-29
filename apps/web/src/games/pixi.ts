// Must load before any Pixi renderer: lets Pixi build shaders without `new Function`,
// so the page can ship a strict CSP with no 'unsafe-eval'.
import "pixi.js/unsafe-eval";

import { Application } from "pixi.js";

export async function createPixi(host: HTMLElement): Promise<Application> {
  const app = new Application();
  await app.init({
    resizeTo: host,
    backgroundAlpha: 0,
    antialias: true,
    autoDensity: true,
    resolution: Math.min(window.devicePixelRatio || 1, 2),
    preference: "webgl",
  });
  app.canvas.setAttribute("aria-hidden", "true");
  host.appendChild(app.canvas);
  return app;
}

export const ease = {
  outCubic: (t: number) => 1 - Math.pow(1 - t, 3),
  inOutCubic: (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  outBack: (t: number) => 1 + 2.7 * Math.pow(t - 1, 3) + 1.7 * Math.pow(t - 1, 2),
};

/** Runs `onUpdate(progress)` on the Pixi ticker for `ms` milliseconds. */
export function tween(
  app: Application,
  ms: number,
  onUpdate: (t: number) => void,
  easing: (t: number) => number = ease.outCubic,
): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0) {
      onUpdate(1);
      resolve();
      return;
    }
    let elapsed = 0;
    const tick = () => {
      elapsed += app.ticker.deltaMS;
      const t = Math.min(elapsed / ms, 1);
      onUpdate(easing(t));
      if (t >= 1) {
        app.ticker.remove(tick);
        resolve();
      }
    };
    app.ticker.add(tick);
  });
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}
