#!/usr/bin/env bash
# 6 s, 320x180, 1 fps counter video with a quiet tone. ~60 KB. Regenerate with this script.
set -euo pipefail
cd "$(dirname "$0")"
ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "testsrc2=size=320x180:rate=10:duration=6" \
  -f lavfi -i "sine=frequency=220:duration=6" \
  -c:v libx264 -crf 32 -pix_fmt yuv420p -c:a aac -b:a 32k -movflags +faststart clip.mp4
