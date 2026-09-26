#!/usr/bin/env bash
set -euo pipefail

package_dir=${1:?package directory required}
package_name=${2:?package name required}
version=${3:?version required}
expected_version=$(node -p "require('$package_dir/package.json').version")
test "$expected_version" = "$version"

pack_dir=$(mktemp -d)
trap 'rm -rf "$pack_dir"' EXIT
local_integrity=$(npm pack "$package_dir" --json --pack-destination "$pack_dir" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const x=JSON.parse(s);if(x.length!==1||!x[0].integrity)process.exit(1);process.stdout.write(x[0].integrity)})')

if published_integrity=$(npm view "$package_name@$version" dist.integrity --json 2>/dev/null); then
  published_integrity=$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s)||""))' <<<"$published_integrity")
  if [[ "$published_integrity" == "$local_integrity" ]]; then
    echo "$package_name@$version already published with matching integrity; skipping"
    exit 0
  fi
  echo "::error::$package_name@$version exists with different integrity" >&2
  exit 1
fi

npm publish "$package_dir" --access public
