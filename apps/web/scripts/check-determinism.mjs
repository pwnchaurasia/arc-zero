// Replays the shared golden vectors through the browser WASM build.
// Fails if any turn produces a different state hash than native Rust.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { BrickTurn, initSync } from "../src/wasm/pkg/arc_engine.js";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
initSync({ module: readFileSync(here("../src/wasm/pkg/arc_engine_bg.wasm")) });

const vectors = JSON.parse(readFileSync(here("../../../crates/arc-engine/tests/golden/brick_blast.json"), "utf8"));
let failed = 0;
for (const [i, v] of vectors.entries()) {
  const turn = new BrickTurn(JSON.stringify(v.state), v.aim);
  const { hash } = JSON.parse(turn.finish());
  if (hash !== v.hash) {
    failed++;
    console.error(`vector ${i}: wasm ${hash} != native ${v.hash}`);
  }
}
if (failed) {
  console.error(`${failed}/${vectors.length} vectors diverged`);
  process.exit(1);
}
console.log(`wasm matches native on ${vectors.length} vectors`);
