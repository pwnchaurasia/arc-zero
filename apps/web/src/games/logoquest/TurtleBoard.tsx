import { useEffect, useRef } from "react";

import type { SkinId, TrailId } from "./cosmetics";
import { colorHex } from "./program";

/** Board units from the centre to each edge (the engine's HALF_BOARD). */
export const HALF = 150;
/** Engine positions are thousandths of a unit. */
const MILLI = 1000;

export interface Line {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
}

export interface Turtle {
  x: number;
  y: number;
  heading: number;
  visible: boolean;
}

/** A turn being shown: the protractor arc from `from` to `to` degrees. */
export interface Arc {
  x: number;
  y: number;
  from: number;
  to: number;
}

/** Engine `[x1, y1, x2, y2, colour]` lines (thousandths) -> board lines. */
export const fromEngine = (lines: (number | string)[][]): Line[] =>
  lines.map(([x1, y1, x2, y2, c]) => ({
    x1: Number(x1) / MILLI,
    y1: Number(y1) / MILLI,
    x2: Number(x2) / MILLI,
    y2: Number(y2) / MILLI,
    color: colorHex(String(c)),
  }));

/** The drawing board: grid, the faint target (Learn), what the turtle drew, the turtle. */
export function TurtleBoard({
  size,
  target,
  showTarget,
  drawn,
  turtle,
  arc,
  hint,
  label,
  skin = "turtle",
  trail = "plain",
  tail = [],
}: {
  size: number;
  target: Line[];
  showTarget: boolean;
  drawn: Line[];
  turtle: Turtle;
  arc: Arc | null;
  hint: Line | null;
  label: string;
  skin?: SkinId;
  trail?: TrailId;
  /** Recent turtle positions, oldest first, for the trail effect. */
  tail?: { x: number; y: number }[];
}) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx || size <= 0) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);
    const k = (size * dpr) / (2 * HALF);
    ctx.setTransform(k, 0, 0, k, (size * dpr) / 2, (size * dpr) / 2);
    ctx.clearRect(-HALF, -HALF, 2 * HALF, 2 * HALF);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    // Squared paper: a line every 25 units, the middle a little brighter.
    ctx.fillStyle = "#0f1630";
    ctx.fillRect(-HALF, -HALF, 2 * HALF, 2 * HALF);
    for (let v = -HALF; v <= HALF; v += 25) {
      ctx.strokeStyle = v === 0 ? "rgba(148,163,184,0.28)" : "rgba(148,163,184,0.12)";
      ctx.lineWidth = 1 / k;
      ctx.beginPath();
      ctx.moveTo(v, -HALF);
      ctx.lineTo(v, HALF);
      ctx.moveTo(-HALF, v);
      ctx.lineTo(HALF, v);
      ctx.stroke();
    }

    if (showTarget) {
      ctx.setLineDash([5, 5]);
      ctx.lineWidth = 4;
      for (const l of target) {
        ctx.strokeStyle = l.color;
        ctx.globalAlpha = 0.32;
        ctx.beginPath();
        ctx.moveTo(l.x1, l.y1);
        ctx.lineTo(l.x2, l.y2);
        ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }

    if (hint) {
      ctx.strokeStyle = "#facc15";
      ctx.lineWidth = 9;
      ctx.globalAlpha = 0.55;
      ctx.beginPath();
      ctx.moveTo(hint.x1, hint.y1);
      ctx.lineTo(hint.x2, hint.y2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    ctx.lineWidth = 3.2;
    ctx.shadowBlur = 6;
    for (const l of drawn) {
      ctx.strokeStyle = l.color;
      ctx.shadowColor = l.color;
      ctx.beginPath();
      ctx.moveTo(l.x1, l.y1);
      ctx.lineTo(l.x2, l.y2);
      ctx.stroke();
    }
    ctx.shadowBlur = 0;

    // The protractor: how far the turtle is turning, with the angle written next to it.
    if (arc && arc.from !== arc.to) {
      const toRad = (deg: number) => ((deg - 90) * Math.PI) / 180;
      const r = 34;
      ctx.strokeStyle = "rgba(250,204,21,0.9)";
      ctx.fillStyle = "rgba(250,204,21,0.15)";
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(arc.x, arc.y);
      ctx.arc(arc.x, arc.y, r, toRad(arc.from), toRad(arc.to), arc.to < arc.from);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      const turned = Math.round(Math.abs(arc.to - arc.from));
      ctx.fillStyle = "#facc15";
      ctx.font = "bold 14px system-ui, sans-serif";
      ctx.textAlign = "center";
      const mid = toRad((arc.from + arc.to) / 2);
      ctx.fillText(`${turned}°`, arc.x + Math.cos(mid) * (r + 14), arc.y + Math.sin(mid) * (r + 14) + 5);
    }

    drawTrail(ctx, trail, tail);
    if (turtle.visible) drawSkin(ctx, turtle, skin);
  }, [size, target, showTarget, drawn, turtle, arc, hint, skin, trail, tail]);

  return (
    <canvas
      ref={ref}
      role="img"
      aria-label={label}
      className="rounded-2xl border border-line"
      style={{ width: size, height: size }}
    />
  );
}

/** One avatar, large, for the look picker. */
export function SkinPreview({ skin, size }: { skin: SkinId; size: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);
    // The avatars are about 30 units tall: fit that to the box.
    const k = (size * dpr) / 36;
    ctx.setTransform(k, 0, 0, k, (size * dpr) / 2, (size * dpr) / 2);
    ctx.clearRect(-18, -18, 36, 36);
    drawSkin(ctx, { x: 0, y: 1, heading: 0, visible: true }, skin);
  }, [skin, size]);
  return <canvas ref={ref} aria-hidden="true" style={{ width: size, height: size }} />;
}

/** A streak behind the moving turtle. It fades by itself and never covers the real lines. */
function drawTrail(ctx: CanvasRenderingContext2D, trail: TrailId, tail: { x: number; y: number }[]) {
  if (trail === "plain" || tail.length < 2) return;
  ctx.save();
  ctx.lineCap = "round";
  for (let i = 1; i < tail.length; i++) {
    const a = tail[i - 1];
    const b = tail[i];
    if (!a || !b) continue;
    const k = i / tail.length; // 0 oldest -> 1 newest
    if (trail === "rainbow") {
      ctx.strokeStyle = `hsla(${(i * 24) % 360}, 95%, 62%, ${k * 0.85})`;
      ctx.lineWidth = 3 + 5 * k;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    } else if (trail === "comet") {
      ctx.strokeStyle = `rgba(251, ${Math.round(146 + 80 * k)}, 60, ${k * 0.8})`;
      ctx.shadowColor = "#f97316";
      ctx.shadowBlur = 12 * k;
      ctx.lineWidth = 2 + 9 * k;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    } else if (i % 2 === 0) {
      // Sparkles: little four-point stars scattered along the path.
      const off = ((i * 7) % 9) - 4;
      drawSparkle(ctx, b.x + off, b.y - off, 2 + 3 * k, `rgba(253, 224, 71, ${k})`);
    }
  }
  ctx.restore();
}

function drawSparkle(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string) {
  ctx.fillStyle = color;
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const rr = i % 2 === 0 ? r : r * 0.35;
    const a = (i * Math.PI) / 4;
    ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  ctx.closePath();
  ctx.fill();
}

/** The player's chosen avatar, seen from above, pointing where it will go (up = forward). */
function drawSkin(ctx: CanvasRenderingContext2D, t: Turtle, skin: SkinId) {
  ctx.save();
  ctx.translate(t.x, t.y);
  ctx.rotate((t.heading * Math.PI) / 180);
  const fill = (color: string, draw: () => void) => {
    ctx.fillStyle = color;
    ctx.beginPath();
    draw();
    ctx.fill();
  };
  switch (skin) {
    case "ladybug":
      fill("#111827", () => ctx.ellipse(0, -10, 4.5, 4, 0, 0, Math.PI * 2));
      fill("#ef4444", () => ctx.ellipse(0, 1, 8.5, 10, 0, 0, Math.PI * 2));
      ctx.strokeStyle = "#111827";
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(0, -8);
      ctx.lineTo(0, 11);
      ctx.stroke();
      for (const [x, y] of [[-4, -3], [4, -3], [-4.5, 4], [4.5, 4], [0, 8]] as const) {
        fill("#111827", () => ctx.arc(x, y, 1.8, 0, Math.PI * 2));
      }
      break;
    case "racecar":
      for (const [x, y] of [[-7, -7], [7, -7], [-7, 7], [7, 7]] as const) {
        fill("#111827", () => ctx.roundRect(x - 2, y - 3, 4, 6, 1));
      }
      fill("#e11d48", () => {
        ctx.moveTo(0, -14);
        ctx.lineTo(6, -6);
        ctx.lineTo(6, 11);
        ctx.lineTo(-6, 11);
        ctx.lineTo(-6, -6);
        ctx.closePath();
      });
      fill("#f8fafc", () => ctx.rect(-1.3, -12, 2.6, 22));
      fill("#38bdf8", () => ctx.roundRect(-4, -4, 8, 5, 1.5));
      break;
    case "rocket":
      fill("#f97316", () => {
        ctx.moveTo(-3.5, 10);
        ctx.lineTo(0, 17);
        ctx.lineTo(3.5, 10);
        ctx.closePath();
      });
      fill("#e11d48", () => {
        ctx.moveTo(-6, 4);
        ctx.lineTo(-9, 11);
        ctx.lineTo(9, 11);
        ctx.lineTo(6, 4);
        ctx.closePath();
      });
      fill("#e2e8f0", () => ctx.ellipse(0, 0, 5.5, 11, 0, 0, Math.PI * 2));
      fill("#e11d48", () => {
        ctx.moveTo(-4.5, -6);
        ctx.quadraticCurveTo(0, -16, 4.5, -6);
        ctx.closePath();
      });
      fill("#38bdf8", () => ctx.arc(0, -1, 2.4, 0, Math.PI * 2));
      break;
    case "hero":
      fill("#dc2626", () => {
        ctx.moveTo(-7, -2);
        ctx.lineTo(-10, 14);
        ctx.lineTo(10, 14);
        ctx.lineTo(7, -2);
        ctx.closePath();
      });
      fill("#2563eb", () => ctx.ellipse(0, 1, 7, 8, 0, 0, Math.PI * 2));
      fill("#facc15", () => ctx.arc(0, 2, 2.6, 0, Math.PI * 2));
      fill("#fcd9b6", () => ctx.arc(0, -9, 4.5, 0, Math.PI * 2));
      fill("#111827", () => ctx.rect(-4.5, -10.5, 9, 2.2));
      break;
    case "ufo":
      fill("#64748b", () => ctx.ellipse(0, 0, 12, 7, 0, 0, Math.PI * 2));
      fill("#67e8f9", () => ctx.ellipse(0, -1.5, 5.5, 4.5, 0, 0, Math.PI * 2));
      for (const a of [0, 1, 2, 3, 4, 5]) {
        const ang = (a * Math.PI) / 3;
        fill(a % 2 ? "#facc15" : "#4ade80", () => ctx.arc(Math.cos(ang) * 9, Math.sin(ang) * 5, 1.4, 0, Math.PI * 2));
      }
      break;
    default:
      drawTurtleBody(ctx);
      if (skin === "king") {
        fill("#facc15", () => {
          ctx.moveTo(-5, 3);
          ctx.lineTo(-5, -4);
          ctx.lineTo(-2.5, -1);
          ctx.lineTo(0, -6);
          ctx.lineTo(2.5, -1);
          ctx.lineTo(5, -4);
          ctx.lineTo(5, 3);
          ctx.closePath();
        });
      }
  }
  ctx.restore();
}

/** A small green turtle seen from above (the default avatar). */
function drawTurtleBody(ctx: CanvasRenderingContext2D) {
  ctx.fillStyle = "#4ade80";
  for (const [x, y] of [
    [-7, -5],
    [7, -5],
    [-7, 6],
    [7, 6],
  ] as const) {
    ctx.beginPath();
    ctx.ellipse(x, y, 3.2, 2.4, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.beginPath();
  ctx.ellipse(0, -11, 3.6, 4, 0, 0, Math.PI * 2); // head
  ctx.fill();
  ctx.fillStyle = "#16a34a";
  ctx.strokeStyle = "#bbf7d0";
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.ellipse(0, 0, 7.5, 9, 0, 0, Math.PI * 2); // shell
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(0, -6);
  ctx.lineTo(0, 6);
  ctx.moveTo(-5, 0);
  ctx.lineTo(5, 0);
  ctx.stroke();
}
