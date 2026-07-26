#!/bin/sh
# sysrec ビルドスクリプト（macOS / Core Audio プロセスタップ + AVAudioEngine）
#
#   sh build.sh            … ビルド + ad-hoc 署名 → ./sysrec
#
# 署名は TCC（マイク/オーディオ録音）権限を安定させるための ad-hoc 署名。
set -e
cd "$(dirname "$0")"

OUT="${1:-sysrec}"

# 版数は manifest.json を単一の真実の源にして生成する。手書き定数だと更新を忘れ、
# 「sysrec を取得」で入れ替えても doctor の表示が変わらず、更新できたか判別できない。
VERSION=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' ../../manifest.json | head -1)
if [ -z "$VERSION" ]; then
  echo "[sysrec] manifest.json から version を取得できません" >&2
  exit 1
fi
echo "[sysrec] version = $VERSION (manifest.json)"
cat > Version.generated.swift <<EOF
// 自動生成（build.sh が manifest.json から書き出す）。手で編集しない。
let sysrecVersion = "$VERSION"
EOF

echo "[sysrec] compiling -> $OUT"
# -swift-version 5: CLI 用途のため厳格な並行性チェックを緩める
# ソースは分割済み（sysrec.swift = 契約/キャプチャ/統括、DspKit = レベル処理、DeviceKit = デバイス）
swiftc -O -swift-version 5 -parse-as-library \
  sysrec.swift DspKit.swift DeviceKit.swift Version.generated.swift -o "$OUT" \
  -framework AVFoundation \
  -framework CoreMedia \
  -framework CoreAudio \
  -framework AudioToolbox

echo "[sysrec] codesign (ad-hoc)"
codesign --force --sign - --entitlements sysrec.entitlements "$OUT"

echo "[sysrec] done: $(cd "$(dirname "$OUT")" && pwd)/$(basename "$OUT")"
echo "[sysrec] 動作確認: ./$OUT --out /tmp/test.m4a --source system  (停止は Ctrl-C)"
