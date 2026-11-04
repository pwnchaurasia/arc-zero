#!/usr/bin/env bash
# Generates every game's levels for one seed with the release-built generator, failing
# if it errors or takes over 10 minutes (releases regenerate levels on every deploy).
# Usage: .github/scripts/ci-levelgen.sh <seed> <out-dir> [extra arc-levelgen args]
set -euo pipefail
seed=$1
out=$2
shift 2
start=$(date +%s)
if ! ARC_LEVEL_SEED="$seed" timeout 600 ./target/release/arc-levelgen --out-dir "$out" "$@" 2> /tmp/levelgen.log; then
  echo "::error::Level generation failed or took over 10 minutes (seed ${seed:0:12}...)"
  tail -20 /tmp/levelgen.log
  exit 1
fi
echo "seed ${seed:0:12}...: $(( $(date +%s) - start ))s, $(grep -c rejected /tmp/levelgen.log || true) layouts rejected"
