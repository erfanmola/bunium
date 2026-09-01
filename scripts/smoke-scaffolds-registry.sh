#!/usr/bin/env bash
# Same coverage as smoke-scaffolds-mac.sh, but exercises the real published
# npm packages end to end instead of the local repo (bunx --bun
# create-bunium-app pulls from the registry, bun install resolves `bunium`
# + its platform package from the registry too -- no `bun link`). This is
# what an actual first-time user experiences; smoke-scaffolds-mac.sh only
# proves the repo's own working tree is internally consistent.
set -o pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

TEMPLATES=(solid-ts solid-js react-ts react-js vue-ts vue-js)
WORKDIR="$(mktemp -d)"
echo "workdir: $WORKDIR"

PASS=()
FAIL=()

for t in "${TEMPLATES[@]}"; do
  echo "=== $t ==="
  dest="$WORKDIR/$t"
  log="/tmp/scaffold-registry-$t.log"
  {
    bunx --bun create-bunium-app "$dest" --template="$t" &&
    cd "$dest" &&
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
    tail -40 "$log"
  fi
done

echo
echo "===================== SUMMARY ====================="
echo "PASS (${#PASS[@]}): ${PASS[*]}"
echo "FAIL (${#FAIL[@]}): ${FAIL[*]}"
echo "logs: /tmp/scaffold-registry-<template>.log, workdir: $WORKDIR"
