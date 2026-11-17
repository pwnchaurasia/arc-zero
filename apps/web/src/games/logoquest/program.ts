/**
 * LogoQuest programs as the chips build them: the same JSON the engine reads
 * (crates/arc-engine/src/logo). Blocks are numbered in reading order, the same way the
 * engine numbers them, so the block running can light up in the code ribbon.
 */

export type Color = "green" | "blue" | "yellow" | "red" | "purple" | "white";

export type Block =
  | { op: "fd" | "bk" | "rt" | "lt"; n: number }
  | { op: "pu" | "pd" }
  | { op: "color"; c: Color }
  | { op: "repeat"; n: number; body: Block[] };

export const COLORS: { id: Color; hex: string; name: string }[] = [
  { id: "green", hex: "#22c55e", name: "Green" },
  { id: "blue", hex: "#38bdf8", name: "Blue" },
  { id: "yellow", hex: "#facc15", name: "Yellow" },
  { id: "red", hex: "#fb7185", name: "Red" },
  { id: "purple", hex: "#a78bfa", name: "Purple" },
  { id: "white", hex: "#f8fafc", name: "White" },
];

export const colorHex = (c: string) => COLORS.find((x) => x.id === c.toLowerCase())?.hex ?? "#22c55e";

/** Where new chips go: a path of REPEAT indexes from the top, then the end of that list. */
export type Cursor = number[];

export function blocks(p: Block[]): number {
  return p.reduce((n, b) => n + 1 + (b.op === "repeat" ? blocks(b.body) : 0), 0);
}

export function depth(p: Block[]): number {
  return p.reduce((d, b) => Math.max(d, b.op === "repeat" ? 1 + depth(b.body) : 0), 0);
}

/** The list the cursor points into. */
function listAt(p: Block[], cursor: Cursor): Block[] {
  let list = p;
  for (const i of cursor) {
    const b = list[i];
    if (!b || b.op !== "repeat") return list;
    list = b.body;
  }
  return list;
}

const clone = (p: Block[]): Block[] => structuredClone(p);

/** Adds a chip at the cursor. A REPEAT opens: the cursor moves inside its brackets. */
export function insert(p: Block[], cursor: Cursor, block: Block): { program: Block[]; cursor: Cursor } {
  const next = clone(p);
  const list = listAt(next, cursor);
  list.push(block);
  return { program: next, cursor: block.op === "repeat" ? [...cursor, list.length - 1] : cursor };
}

/** Reading-order id -> path of indexes to that block. */
export function pathOf(p: Block[], id: number): number[] | null {
  let next = 0;
  const walk = (list: Block[], prefix: number[]): number[] | null => {
    for (let i = 0; i < list.length; i++) {
      if (next === id) return [...prefix, i];
      next++;
      const b = list[i];
      if (b?.op === "repeat") {
        const found = walk(b.body, [...prefix, i]);
        if (found) return found;
      }
    }
    return null;
  };
  return walk(p, []);
}

export function blockAt(p: Block[], path: number[]): Block | undefined {
  let list = p;
  let b: Block | undefined;
  for (const i of path) {
    b = list[i];
    if (!b) return undefined;
    if (b.op === "repeat") list = b.body;
  }
  return b;
}

/** Removes the block with this id (and everything inside it). The cursor goes back to the top. */
export function remove(p: Block[], id: number): Block[] {
  const path = pathOf(p, id);
  if (!path) return p;
  const next = clone(p);
  const parent = listAt(next, path.slice(0, -1));
  parent.splice(path[path.length - 1] ?? 0, 1);
  return next;
}

/** Changes a block's number (distance, angle or count) or colour. */
export function update(p: Block[], id: number, change: { n?: number; c?: Color }): Block[] {
  const path = pathOf(p, id);
  if (!path) return p;
  const next = clone(p);
  const b = blockAt(next, path);
  if (!b) return p;
  if (change.n !== undefined && "n" in b) b.n = change.n;
  if (change.c !== undefined && b.op === "color") b.c = change.c;
  return next;
}

/** One piece of the code ribbon: the text of a block, or a bracket. */
export interface Token {
  text: string;
  /** Reading-order id of the block, or null for brackets. */
  id: number | null;
  /** Brackets: the id of their REPEAT. */
  of?: number;
  /** How deep inside REPEATs. */
  level: number;
}

const word = (b: Block) => {
  switch (b.op) {
    case "fd":
    case "bk":
    case "rt":
    case "lt":
      return `${b.op.toUpperCase()} ${b.n}`;
    case "repeat":
      return `REPEAT ${b.n}`;
    case "color":
      return `COLOR ${b.c.toUpperCase()}`;
    default:
      return b.op.toUpperCase();
  }
};

/** The program as Logo text, one token per block, e.g. REPEAT 4 [ FD 100 RT 90 ]. */
export function tokens(p: Block[]): Token[] {
  const out: Token[] = [];
  let next = 0;
  const walk = (list: Block[], level: number) => {
    for (const b of list) {
      const id = next++;
      out.push({ text: word(b), id, level });
      if (b.op === "repeat") {
        out.push({ text: "[", id: null, of: id, level });
        walk(b.body, level + 1);
        out.push({ text: "]", id: null, of: id, level });
      }
    }
  };
  walk(p, 0);
  return out;
}

/** Path of indexes -> reading-order id (the inverse of pathOf). */
export function idOf(p: Block[], path: number[]): number | null {
  let next = 0;
  let list = p;
  for (const [depthIndex, target] of path.entries()) {
    for (let i = 0; i < target; i++) next += 1 + (list[i]?.op === "repeat" ? blocks((list[i] as { body: Block[] }).body) : 0);
    if (depthIndex === path.length - 1) return next;
    const b = list[target];
    if (!b || b.op !== "repeat") return null;
    next += 1;
    list = b.body;
  }
  return null;
}

export const toText = (p: Block[]) => tokens(p).map((t) => t.text).join(" ");
