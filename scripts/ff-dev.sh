#!/usr/bin/env bash
# Stages the source with the Firefox manifest and launches Firefox via web-ext.
# Re-run after editing source files (the stage is a copy, not a live link).
set -euo pipefail
cd "$(dirname "$0")/.."
STAGE=$(mktemp -d)
cp -R background.js options.html options.js icons "$STAGE/"
cp manifest.firefox.json "$STAGE/manifest.json"
echo "staged at $STAGE"
npx --yes web-ext run --source-dir "$STAGE"
