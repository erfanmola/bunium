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

# A session D-Bus lets system-notifications-test.ts exercise the real
# org.freedesktop.Notifications path (see bunium_system_notify_linux.cc);
# without one it degrades gracefully (no crash, notify silently no-ops) but
# doesn't prove anything. No notification daemon owns the well-known name
# here (no GNOME/KDE session) -- see docker/linux/fake_notify_daemon.c for
# a real end-to-end round-trip check outside this sweep.
if [ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ]; then
  eval "$(dbus-launch --sh-syntax)"
fi

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
