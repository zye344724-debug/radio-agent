#!/usr/bin/env bash
set -euo pipefail
project_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
rm -rf "$project_root/dist"
node "$project_root/scripts/build-assets.mjs"
