/**
 * Cipher9 board helpers for the browser. The browser never has the solution: it can
 * only see where a number repeats in a row, column or box. The server replays the moves
 * and has the final say (crates/arc-engine/src/cipher9).
 */

export const CELLS = 81;
export const DIGITS = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const;
/** Candidate mask with bits 1..9 set. */
export const ALL = 0b11_1111_1110;

export const rowOf = (cell: number) => Math.floor(cell / 9);
export const colOf = (cell: number) => cell % 9;
export const boxOf = (cell: number) => Math.floor(cell / 27) * 3 + Math.floor((cell % 9) / 3);

export type UnitKind = "row" | "column" | "box";

/** The 9 cells of a row, column or box. */
export function unitCells(kind: UnitKind, index: number): number[] {
  return Array.from({ length: 9 }, (_, j) => {
    if (kind === "row") return index * 9 + j;
    if (kind === "column") return j * 9 + index;
    return Math.floor(index / 3) * 27 + (index % 3) * 3 + Math.floor(j / 3) * 9 + (j % 3);
  });
}

/** The 20 cells sharing a row, column or box with each cell. */
export const PEERS: readonly (readonly number[])[] = Array.from({ length: CELLS }, (_, c) =>
  Array.from({ length: CELLS }, (_, o) => o).filter(
    (o) => o !== c && (rowOf(o) === rowOf(c) || colOf(o) === colOf(c) || boxOf(o) === boxOf(c)),
  ),
);

export const bit = (digit: number) => 1 << digit;
export const hasDigit = (mask: number, digit: number) => (mask & bit(digit)) !== 0;

/** Cells whose number repeats in their row, column or box. */
export function clashes(values: readonly number[]): Set<number> {
  const out = new Set<number>();
  for (let c = 0; c < CELLS; c++) {
    const d = values[c];
    if (!d) continue;
    for (const p of PEERS[c] ?? []) {
      if (values[p] === d) {
        out.add(c);
        break;
      }
    }
  }
  return out;
}

/** The numbers that could still go in an empty cell, as a mask. */
export function candidates(values: readonly number[], cell: number): number {
  if (values[cell]) return 0;
  let used = 0;
  for (const p of PEERS[cell] ?? []) used |= bit(values[p] ?? 0);
  return ALL & ~used;
}

/** How many times each digit (index 1..9) is on the board. */
export function counts(values: readonly number[]): number[] {
  const out = Array.from({ length: 10 }, () => 0);
  for (const d of values) out[d] = (out[d] ?? 0) + 1;
  return out;
}

/** Full with nothing repeated: with one solution, that is the solution. */
export function looksSolved(values: readonly number[]): boolean {
  return values.every((d) => d > 0) && clashes(values).size === 0;
}

const TECHNIQUES: Record<string, string> = {
  naked_single: "naked singles",
  hidden_single: "hidden singles",
  naked_pair: "naked pairs",
  locked_candidates: "locked candidates",
  x_wing: "an X-Wing",
  xy_wing: "an XY-Wing",
};

const LABELS: Record<string, string> = {
  naked_single: "Naked single",
  hidden_single: "Hidden single",
  naked_pair: "Naked pair",
  locked_candidates: "Locked candidates",
  x_wing: "X-Wing",
  xy_wing: "XY-Wing",
};

const TIERS: Record<string, string> = {
  warmup: "Warmup",
  casual: "Casual",
  tactical: "Tactical",
  master: "Master",
};

export const tierName = (tier: string) => TIERS[tier] ?? tier;
/** A technique's name as a title, e.g. "Hidden single". */
export const techniqueLabel = (technique: string) => LABELS[technique] ?? technique.replace(/_/g, " ");
export const techniqueName = (technique: string) => TECHNIQUES[technique] ?? technique.replace(/_/g, " ");

export interface HintInfo {
  cell: number;
  digit: number;
  technique: string | null;
  unit_kind: UnitKind | null;
  unit: number | null;
  after: string[];
}

/** One or two sentences a person can follow. */
export function explain(h: HintInfo): string {
  const where = `row ${rowOf(h.cell) + 1}, column ${colOf(h.cell) + 1}`;
  if (h.technique === null) {
    return `No simple step is left, so this reveals one number: ${h.digit} at ${where}.`;
  }
  const first = h.after.length
    ? `First, ${h.after.map(techniqueName).join(" and ")} cross${h.after.length === 1 && !h.after[0]?.endsWith("s") ? "es" : ""} out some options. Then `
    : "";
  if (h.technique === "hidden_single" && h.unit_kind && h.unit !== null) {
    const unit = `${h.unit_kind} ${h.unit + 1}`;
    return `${first}${first ? "in" : "In"} ${unit}, ${h.digit} fits in only one cell: ${where}.`;
  }
  return `${first}${first ? "at" : "At"} ${where}, every number but ${h.digit} is already used in its row, column or box.`;
}

/** Seconds as M:SS, or H:MM:SS from an hour. */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}
