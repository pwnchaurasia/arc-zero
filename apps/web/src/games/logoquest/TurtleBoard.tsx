import { useEffect, useRef } from "react";

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
}: {
  size: number;
  target: Line[];
  showTarget: boolean;
  drawn: Line[];
  turtle: Turtle;
  arc: Arc | null;
  hint: Line | null;
  label: string;
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

    if (turtle.visible) drawTurtle(ctx, turtle);
  }, [size, target, showTarget, drawn, turtle, arc, hint]);

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

/** A small green turtle seen from above, pointing where it will walk. */
function drawTurtle(ctx: CanvasRenderingContext2D, t: Turtle) {
  ctx.save();
  ctx.translate(t.x, t.y);
  ctx.rotate((t.heading * Math.PI) / 180);
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
  ctx.restore();
}
