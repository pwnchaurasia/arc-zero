import { useId } from "react";

import type { GameId } from "../api/types";

/**
 * Square logo for a game tile. Uses the game's image when one is configured,
 * otherwise a drawn placeholder in the game's own art style.
 */
export function GameLogo({ game, image }: { game: GameId; image?: string }) {
  if (image) {
    return (
      <img
        src={image}
        alt=""
        width={512}
        height={512}
        loading="lazy"
        decoding="async"
        className="aspect-square w-full object-cover"
      />
    );
  }
  return game === "water-sort" ? <WaterSortArt /> : <BrickBlastArt />;
}

const svgProps = {
  viewBox: "0 0 100 100",
  className: "aspect-square w-full",
  "aria-hidden": true,
} as const;

/** Three glass bottles with coloured layers; blue is being poured into the last one. */
function WaterSortArt() {
  const id = useId();
  const bottles = [
    { x: 14, layers: ["#ef4444", "#3b82f6", "#ef4444", "#22c55e"] },
    { x: 41, layers: ["#facc15", "#a855f7", "#facc15"] },
    { x: 68, layers: ["#3b82f6", "#3b82f6"] },
  ];
  return (
    <svg {...svgProps}>
      <rect width="100" height="100" fill="#0f1630" />
      <circle cx="50" cy="58" r="38" fill="#38bdf8" opacity="0.08" />
      {bottles.map((b, i) => {
        const clip = `${id}-b${i}`;
        const shape = `M${b.x} 30 h18 v42 a9 9 0 0 1 -18 0 Z`;
        return (
          <g key={i}>
            <clipPath id={clip}>
              <path d={shape} />
            </clipPath>
            <g clipPath={`url(#${clip})`}>
              {b.layers.map((color, k) => (
                <rect key={k} x={b.x} y={72 + 9 - (k + 1) * 11} width="18" height="11" fill={color} />
              ))}
            </g>
            <path d={shape} fill="none" stroke="#cbd5ff" strokeOpacity="0.8" strokeWidth="2" />
            <rect x={b.x + 3} y="35" width="2.5" height="26" rx="1.2" fill="#fff" opacity="0.18" />
          </g>
        );
      })}
      {/* The pour: a stream falling into the last bottle, landing on its blue layers. */}
      <path d="M77 6 L 77 58" stroke="#3b82f6" strokeWidth="3.2" strokeLinecap="round" />
      <circle cx="73" cy="57" r="1.3" fill="#93c5fd" />
      <circle cx="81" cy="56" r="1.1" fill="#93c5fd" />
    </svg>
  );
}

/** Bevelled gem blocks, a ball path and a burst, lit from the top-left like the game. */
function BrickBlastArt() {
  const s = 20;
  const blocks: [number, number, string][] = [
    [15, 14, "#ef4444"],
    [40, 14, "#f97316"],
    [65, 14, "#8b5cf6"],
    [15, 39, "#0ea5e9"],
    [65, 39, "#14b8a6"],
    [40, 39, "#22c55e"],
  ];
  const facet = (x: number, y: number, face: string, shade: string, k: number) => {
    const i = s * 0.22;
    const pts = [
      [x, y, x + s, y, x + s - i, y + i, x + i, y + i], // top
      [x, y, x + i, y + i, x + i, y + s - i, x, y + s], // left
      [x + s, y, x + s, y + s, x + s - i, y + s - i, x + s - i, y + i], // right
      [x, y + s, x + i, y + s - i, x + s - i, y + s - i, x + s, y + s], // bottom
    ];
    const light = ["#ffffff", "#ffffff", "#000000", "#000000"];
    const alpha = [0.45, 0.2, 0.2, 0.4];
    return (
      <g key={k}>
        <rect x={x} y={y} width={s} height={s} fill={face} />
        {pts.map((p, j) => (
          <polygon key={j} points={p.join(" ")} fill={light[j]} opacity={alpha[j]} />
        ))}
        <rect x={x} y={y} width={s} height={s} fill="none" stroke={shade} strokeOpacity="0.6" />
      </g>
    );
  };
  return (
    <svg {...svgProps}>
      <rect width="100" height="100" fill="#0f1630" />
      {blocks.map(([x, y, c], k) => facet(x, y, c, "#000", k))}
      {/* Burst where the ball hits the green block. */}
      {[0, 60, 120, 180, 240, 300].map((a) => (
        <rect
          key={a}
          x="48.5"
          y="47.5"
          width="3"
          height="3"
          fill="#facc15"
          transform={`rotate(${a} 50 49) translate(0 -13)`}
        />
      ))}
      {/* Aim guide and balls rising from the launcher. */}
      <path d="M50 92 L 50 66" stroke="#fff" strokeOpacity="0.5" strokeWidth="1.6" strokeDasharray="1.6 3.2" />
      <circle cx="50" cy="92" r="3.4" fill="#fff" />
      <circle cx="50" cy="78" r="3" fill="#fff" opacity="0.9" />
      <circle cx="50" cy="66" r="3" fill="#fff" opacity="0.75" />
      <circle cx="80" cy="72" r="6" fill="none" stroke="#38bdf8" strokeWidth="1.6" />
      <circle cx="80" cy="72" r="2" fill="#38bdf8" />
    </svg>
  );
}
