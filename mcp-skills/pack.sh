#!/usr/bin/env sh
# Build one uploadable zip per skill into dist/.
set -eu

cd "$(dirname "$0")"
rm -rf dist
mkdir -p dist

for dir in limitless-*/; do
  name="${dir%/}"
  if [ ! -f "$name/SKILL.md" ]; then
    echo "skip $name: no SKILL.md" >&2
    continue
  fi
  zip -q -r "dist/$name.zip" "$name" -x '*.DS_Store'
  echo "dist/$name.zip"
done
