#!/usr/bin/env bash
# Downloads the face-landmark engine + model into web/ so the app runs fully offline.
set -euo pipefail
cd "$(dirname "$0")/.."
MP_VER="0.10.14"
TMP="$(mktemp -d)"
( cd "$TMP" && npm init -y >/dev/null && npm install "@mediapipe/tasks-vision@${MP_VER}" --no-audit --no-fund )
PKG="$TMP/node_modules/@mediapipe/tasks-vision"
mkdir -p web/vendor/wasm web/models
cp "$PKG/vision_bundle.mjs" web/vendor/vision_bundle.js
cp "$PKG"/wasm/* web/vendor/wasm/
curl -fL --retry 3 -o web/models/face_landmarker.task \
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task"
rm -rf "$TMP"
ls -la web/vendor web/vendor/wasm web/models
