#!/usr/bin/env bash
# Guided screenshot capture for the README gallery.
# For each shot: set up the view it names, press Return, then CLICK the window
# you want. It captures just that window (no desktop, no drop shadow) into
# docs/screenshots/. Re-run any time to retake — it overwrites by name.
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)/docs/screenshots"
mkdir -p "$DIR"

shot() {
  echo
  echo "▶ $2"
  read -r -p "   Set it up, then press Return — then click the window…"
  screencapture -o -w "$DIR/$1.png"
  echo "   ✓ saved $1.png"
}

echo "WinzAMP screenshot capture — launch WinzAMP first if it isn't open."
shot player-winzamp "Main player — built-in WinzAMP skin"
shot player-classic "Main player — Winamp Classic skin (switch skin first)"
shot skin-fun       "A fun skin — Zelda / Pip-Boy / Mario (your pick)"
shot eq             "Equalizer — open it, turn it ON, nudge some sliders"
shot milkdrop       "Milkdrop — open it and let a preset run"
shot karaoke        "Karaoke — open it with a song playing so lyrics show"
echo
echo "All set. Files are in docs/screenshots/ — tell Claude and it'll wire them into the README."
