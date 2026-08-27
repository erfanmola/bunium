#!/usr/bin/env bash
# Smoke-tests every create-bunium-app template on real macOS hardware:
# scaffold -> bun link bunium (repo isn't published) -> bun install ->
# vite build -> verify-prod.ts against dist/ (real window + pixel check),
# same "real prod path" spirit as packaging/mac/fixture-app. One template
# at a time -- CEF ProcessSingleton rule applies here too.
set -o pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

TEMPLATES=(solid-ts solid-js react-ts react-js vue-ts vue-js)
WORKDIR="$(mktemp -d)"
echo "workdir: $WORKDIR"

PASS=()
FAIL=()

for t in "${TEMPLATES[@]}"; do
  echo "=== $t ==="
  dest="$WORKDIR/$t"
  log="/tmp/scaffold-$t.log"
  {
    bun "$REPO/create-bunium-app/index.ts" "$dest" --template="$t" &&
    cd "$dest" &&
    bun link bunium &&
    bun install &&
    bun run build &&
    bun "$REPO/create-bunium-app/verify-prod.ts" "$dest/dist"
  } > "$log" 2>&1
  code=$?
  cd "$REPO"
  if [ "$code" -eq 0 ] && grep -q "frame dims" "$log"; then
    echo "PASS: $t"
    PASS+=("$t")
  else
    echo "FAIL: $t (exit $code)"
    FAIL+=("$t")
    tail -25 "$log"
  fi
done

echo
echo "===================== SUMMARY ====================="
echo "PASS (${#PASS[@]}): ${PASS[*]}"
echo "FAIL (${#FAIL[@]}): ${FAIL[*]}"
echo "logs: /tmp/scaffold-<template>.log, workdir: $WORKDIR"
