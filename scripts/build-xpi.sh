#!/usr/bin/env bash
# Package the extension directory into an installable .xpi (a plain zip).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/kloot-in-firefox.xpi"

cd "$ROOT/extension"
rm -f "$OUT"
zip -qr "$OUT" . -x '*.swp' -x '.*'

echo "built $OUT"
