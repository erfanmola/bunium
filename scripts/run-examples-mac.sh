#!/usr/bin/env bash
# Runs every examples/*.ts sequentially on real macOS hardware (one at a
# time -- CEF's ProcessSingleton aborts a concurrent second process), and
# prints a pass/fail summary. Mirrors docker/linux/run-examples.sh.
#
# Skips known non-runnable entries: vite-dev-fixture/ (a fixture dir, not a
# script) and anything passed via SKIP (space-separated basenames).
set -o pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

TIMEOUT="${TIMEOUT:-30}"
SKIP="${SKIP:-}"

# macOS has no GNU `timeout` by default -- run in background, poll, kill on
# expiry (also kills any leftover CEF subprocess tree via the process group).
run_with_timeout() {
  local secs="$1"; shift
  ("$@") &
  local pid=$!
  local waited=0
  while kill -0 "$pid" 2>/dev/null; do
    sleep 1
    waited=$((waited + 1))
    if [ "$waited" -ge "$secs" ]; then
      kill -TERM "$pid" 2>/dev/null
      sleep 1
      kill -KILL "$pid" 2>/dev/null
      wait "$pid" 2>/dev/null
      return 124
    fi
  done
  wait "$pid"
}

PASS=()
FAIL=()
SKIPPED=()

for f in examples/*.ts; do
  name="$(basename "$f")"
  case " $SKIP " in
    *" $name "*)
      echo "=== $name === SKIPPED"
      SKIPPED+=("$name")
      continue
      ;;
  esac
  echo "=== $name ==="
  if run_with_timeout "$TIMEOUT" bun run "$f" > "/tmp/example-$name.log" 2>&1; then
    echo "PASS: $name"
    PASS+=("$name")
  else
    code=$?
    echo "FAIL: $name (exit $code)"
    FAIL+=("$name")
    tail -15 "/tmp/example-$name.log"
  fi
done

echo
echo "===================== SUMMARY ====================="
echo "PASS (${#PASS[@]}): ${PASS[*]}"
echo "FAIL (${#FAIL[@]}): ${FAIL[*]}"
echo "SKIPPED (${#SKIPPED[@]}): ${SKIPPED[*]}"
