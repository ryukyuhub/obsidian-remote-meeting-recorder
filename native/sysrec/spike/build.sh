#!/bin/sh
# DRM対策 Spike ビルドスクリプト（隔離試作・本番 sysrec とは別物）
#
#   sh build.sh          … tap / micsck をビルド + ad-hoc 署名
#
# 署名は TCC（マイク/オーディオ）権限プロンプトを安定させるための ad-hoc 署名。
set -e
cd "$(dirname "$0")"

# 本番と同じ entitlements（audio-input）を流用。タップに追加権限が要るかは Spike ③ で確定する。
ENT="../sysrec.entitlements"

echo "[spike] compiling tap -> ./tap"
swiftc -O -swift-version 5 tap.swift -o tap \
  -framework Foundation \
  -framework CoreAudio \
  -framework AVFoundation
codesign --force --sign - --entitlements "$ENT" tap

echo "[spike] compiling micsck -> ./micsck"
swiftc -O -swift-version 5 micsck.swift -o micsck \
  -framework Foundation \
  -framework ScreenCaptureKit \
  -framework AVFoundation \
  -framework CoreMedia
codesign --force --sign - --entitlements "$ENT" micsck

echo "[spike] done."
echo "  ① 本命: ./tap --seconds 20 --out /tmp/tap-spike.wav   （録音中に Netflix 再生 → 黒くならないか）"
echo "  ④ 確定: ./micsck --seconds 20                          （録音中に Netflix 再生 → 黒くなるか）"
