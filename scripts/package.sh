#!/usr/bin/env bash
# Builds the Chrome and Firefox release zips into store-assets/.
# Usage: scripts/package.sh
set -euo pipefail
cd "$(dirname "$0")/.."

if grep -qE 'const (DEBUG|PERSIST_LOGS) = true' background.js; then
  echo "ERROR: DEBUG/PERSIST_LOGS still true in background.js - set both to false before packaging" >&2
  exit 1
fi

VERSION=$(node -p "require('./manifest.json').version")
FF_VERSION=$(node -p "require('./manifest.firefox.json').version")
if [[ "$VERSION" != "$FF_VERSION" ]]; then
  echo "ERROR: version mismatch - manifest.json=$VERSION manifest.firefox.json=$FF_VERSION" >&2
  exit 1
fi

FILES=(background.js options.html options.js icons)

build() {  # $1 = browser label, $2 = manifest file
  local out="$PWD/store-assets/anchrd-tabs-${VERSION}-$1.zip"
  local stage
  stage=$(mktemp -d)
  cp -R "${FILES[@]}" "$stage/"
  cp "$2" "$stage/manifest.json"
  find "$stage" -name .DS_Store -delete
  rm -f "$out"
  (cd "$stage" && zip -rq "$out" .)
  rm -rf "$stage"
  echo "built store-assets/anchrd-tabs-${VERSION}-$1.zip"
}

build chrome  manifest.json
build firefox manifest.firefox.json
