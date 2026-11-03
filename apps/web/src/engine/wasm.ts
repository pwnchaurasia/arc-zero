import init, * as engine from "../wasm/pkg/arc_engine";

let ready: Promise<void> | null = null;

/** Loads the WebAssembly game engine once. Safe to call repeatedly. */
export function loadEngine(): Promise<void> {
  ready ??= init().then(() => undefined);
  return ready;
}

export { engine };

export interface BbConstants {
  cols: number;
  rows: number;
  playRows: number;
  cell: number;
  boardW: number;
  floorY: number;
  ballR: number;
  blockInset: number;
  powerR: number;
  ticksPerSecond: number;
  aimMin: number;
  aimMax: number;
  maxHp: number;
}

let constants: BbConstants | null = null;

/** Brick Blast geometry, straight from the engine (never hard-coded in the renderer). */
export function bbConstants(): BbConstants {
  constants ??= JSON.parse(engine.bbConstants()) as BbConstants;
  return constants;
}

export interface MjConstants {
  kinds: { kind: string; seats: number; riders: number; length: number }[];
  maxMoves: number;
  maxExtraBays: number;
  shuffleWindow: number;
}

let mj: MjConstants | null = null;

/** MetroJam vehicle seats and sizes, straight from the engine. */
export function mjConstants(): MjConstants {
  mj ??= JSON.parse(engine.mjConstants()) as MjConstants;
  return mj;
}

let db: import("../games/dead-bridge/DeadBridgeView").DbConstants | null = null;

/** Dead Bridge geometry and timing, straight from the engine. */
export function dbConstants(): import("../games/dead-bridge/DeadBridgeView").DbConstants {
  db ??= JSON.parse(engine.dbConstants()) as import("../games/dead-bridge/DeadBridgeView").DbConstants;
  return db;
}
