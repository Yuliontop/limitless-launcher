#!/usr/bin/env bash
# Builds the signed installer + latest.json that the in-app updater reads, into dist/v<version>/.
#   scripts/release.sh                       build only
#   scripts/release.sh --publish notes.md    build, then create the GitHub release (marked latest)
# Bump "version" in src-tauri/tauri.conf.json and src-tauri/Cargo.toml first.
# The signing key never goes in the repo; lose it and existing installs can't verify updates anymore.
set -euo pipefail
cd "$(dirname "$0")/.."
key="${TAURI_KEY_FILE:-$HOME/.tauri/limitless-launcher.key}"
ver=$(python -c "import json; print(json.load(open('src-tauri/tauri.conf.json'))['version'])")
asset="LimitlessLauncher-$ver-setup.exe" # no spaces: GitHub would turn them into dots
out="dist/v$ver"
nsis="src-tauri/target/release/bundle/nsis/Limitless Launcher_${ver}_x64-setup.exe"

(cd src-tauri && TAURI_SIGNING_PRIVATE_KEY="$(cat "$key")" TAURI_SIGNING_PRIVATE_KEY_PASSWORD= cargo tauri build)
mkdir -p "$out"
cp "$nsis" "$out/$asset"
python - "$ver" "$asset" "$nsis.sig" "$out/latest.json" <<'EOF'
import datetime, json, sys
ver, asset, sig, dest = sys.argv[1:]
json.dump({
    "version": ver,
    "pub_date": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "platforms": {"windows-x86_64": {
        "signature": open(sig).read().strip(),
        "url": f"https://github.com/Yuliontop/limitless-launcher/releases/download/v{ver}/{asset}",
    }},
}, open(dest, "w"), indent=2)
EOF
echo "built $out"

if [[ "${1:-}" == --publish ]]; then
  gh release create "v$ver" "$out/$asset" "$out/latest.json" --title "Limitless Launcher v$ver" --notes-file "${2:?notes file}"
fi
