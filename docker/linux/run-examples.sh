#!/usr/bin/env bash
# Runs every examples/*-test.ts (+ basic-window.ts) sequentially under Xvfb
# inside the container, one at a time (CEF's ProcessSingleton aborts a
# concurrent second process -- same rule as macOS/Windows), and prints a
# pass/fail summary. Mirrors the "full examples/ sweep" verification step
# mac/win did after their own Phase 0-1 bring-up (see PLAN.md Phase 6/7).
set -uo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

Xvfb :99 -screen 0 1024x768x24 >/tmp/xvfb.log 2>&1 &
XVFB_PID=$!
sleep 1
export DISPLAY=:99

PASS=()
FAIL=()

for f in examples/*.ts; do
  name="$(basename "$f")"
  echo "=== $name ==="
  if timeout 30 bun run "$f" > "/tmp/example-$name.log" 2>&1; then
    echo "PASS: $name"
    PASS+=("$name")
  else
    echo "FAIL: $name (exit $?)"
    FAIL+=("$name")
    tail -15 "/tmp/example-$name.log"
  fi
done

kill "$XVFB_PID" 2>/dev/null

echo
echo "===================== SUMMARY ====================="
echo "PASS (${#PASS[@]}): ${PASS[*]}"
echo "FAIL (${#FAIL[@]}): ${FAIL[*]}"
