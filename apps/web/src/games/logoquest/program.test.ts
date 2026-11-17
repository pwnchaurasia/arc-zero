import { describe, expect, it } from "vitest";

import { blockAt, blocks, depth, idOf, insert, pathOf, remove, toText, update, type Block } from "./program";

const square = (): Block[] => [{ op: "repeat", n: 4, body: [{ op: "fd", n: 100 }, { op: "rt", n: 90 }] }];

describe("building programs from chips", () => {
  it("adds inside an open REPEAT, then after it", () => {
    let s = insert([], [], { op: "repeat", n: 4, body: [] });
    expect(s.cursor).toEqual([0]);
    s = insert(s.program, s.cursor, { op: "fd", n: 100 });
    s = insert(s.program, s.cursor, { op: "rt", n: 90 });
    s = insert(s.program, [], { op: "pu" });
    expect(toText(s.program)).toBe("REPEAT 4 [ FD 100 RT 90 ] PU");
    expect([blocks(s.program), depth(s.program)]).toEqual([4, 1]);
  });

  it("numbers blocks in reading order like the engine", () => {
    const p = [{ op: "fd", n: 10 } as Block, ...square()];
    expect(pathOf(p, 0)).toEqual([0]);
    expect(pathOf(p, 1)).toEqual([1]);
    expect(pathOf(p, 3)).toEqual([1, 1]);
    expect(blockAt(p, [1, 1])).toEqual({ op: "rt", n: 90 });
    for (const id of [0, 1, 2, 3]) expect(idOf(p, pathOf(p, id) ?? [])).toBe(id);
  });

  it("edits and deletes blocks without touching the original", () => {
    const p = square();
    const longer = update(p, 1, { n: 50 });
    expect(toText(longer)).toBe("REPEAT 4 [ FD 50 RT 90 ]");
    expect(toText(p)).toBe("REPEAT 4 [ FD 100 RT 90 ]");
    expect(toText(remove(p, 2))).toBe("REPEAT 4 [ FD 100 ]");
    expect(toText(remove(p, 0))).toBe("");
  });
});
