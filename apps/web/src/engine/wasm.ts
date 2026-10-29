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
