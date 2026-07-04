#!/bin/sh
# sysrec ビルドスクリプト（macOS / ScreenCaptureKit）
#
#   sh build.sh            … ビルド + ad-hoc 署名 → ./sysrec
#
# 署名は TCC（画面収録・マイク）権限を安定させるための ad-hoc 署名。
set -e
cd "$(dirname "$0")"

OUT="${1:-sysrec}"

echo "[sysrec] compiling -> $OUT"
# -swift-version 5: CLI 用途のため厳格な並行性チェックを緩める
swiftc -O -swift-version 5 -parse-as-library sysrec.swift -o "$OUT" \
  -framework AVFoundation \
  -framework ScreenCaptureKit \
  -framework CoreMedia \
  -framework CoreAudio

echo "[sysrec] codesign (ad-hoc)"
codesign --force --sign - --entitlements sysrec.entitlements "$OUT"

echo "[sysrec] done: $(cd "$(dirname "$OUT")" && pwd)/$(basename "$OUT")"
echo "[sysrec] 動作確認: ./$OUT --out /tmp/test.m4a --source system  (停止は Ctrl-C)"
