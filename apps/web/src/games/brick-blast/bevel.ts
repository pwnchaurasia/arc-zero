import type { Graphics } from "pixi.js";

import { shade } from "../colors";

/** Light comes from the upper left (screen y points down): top edges brightest. */
const LIGHT = (() => {
  const x = -0.5;
  const y = -1;
  const len = Math.hypot(x, y);
  return { x: x / len, y: y / len };
})();

/** Size of the raised centre face relative to the whole block. */
const FACE = 0.58;
/** How strongly facets are lit or shaded. */
const RELIEF = 0.55;

/**
 * Draws a convex polygon (flat [x0, y0, x1, y1, ...]) as a bevelled, raised gem:
 * one slanted facet per edge, lit by how much it faces the light, around a flat
 * centre face. Works for squares and every triangle orientation alike.
 * Returns the centroid, where a label should sit.
 */
export function drawBevelled(
  g: Graphics,
  pts: number[],
  color: number,
  outlineWidth: number,
): { x: number; y: number } {
  const n = pts.length / 2;
  const px = (i: number) => pts[(i % n) * 2] ?? 0;
  const py = (i: number) => pts[(i % n) * 2 + 1] ?? 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < n; i++) {
    cx += px(i);
    cy += py(i);
  }
  cx /= n;
  cy /= n;
  const ix = (i: number) => cx + (px(i) - cx) * FACE;
  const iy = (i: number) => cy + (py(i) - cy) * FACE;

  for (let i = 0; i < n; i++) {
    const dx = px(i + 1) - px(i);
    const dy = py(i + 1) - py(i);
    const len = Math.hypot(dx, dy) || 1;
    let nx = dy / len;
    let ny = -dx / len;
    // Make the normal point outward (away from the centroid).
    const mx = (px(i) + px(i + 1)) / 2 - cx;
    const my = (py(i) + py(i + 1)) / 2 - cy;
    if (nx * mx + ny * my < 0) {
      nx = -nx;
      ny = -ny;
    }
    const facing = nx * LIGHT.x + ny * LIGHT.y; // -1 (in shadow) .. 1 (fully lit)
    g.poly([px(i), py(i), px(i + 1), py(i + 1), ix(i + 1), iy(i + 1), ix(i), iy(i)]).fill(
      shade(color, facing * RELIEF),
    );
  }

  const face: number[] = [];
  for (let i = 0; i < n; i++) face.push(ix(i), iy(i));
  g.poly(face).fill(shade(color, 0.06));
  g.poly(pts).stroke({ width: outlineWidth, color: shade(color, -0.55), alpha: 0.9 });
  return { x: cx, y: cy };
}
