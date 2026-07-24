#!/bin/bash
# =====================================================================
# 実音声ゴールデンテスト（macOS ローカル専用）: npm run test:audio
#
# なにを検証するか（fake-binary E2E が見ていない層）:
#   1. 実バイナリ sysrec で AutoGain × 手動ミキサー × source の 9 通りを実録音し、
#      プラグインと同じ仕上げ（single→normalize / both→mix）を通した最終ファイルが
#      目標ラウドネス（-16 dBFS 近傍）に収まること。
#   2. 録音中に既定出力デバイスを切り替えても、システム音の取り込みが追従して
#      続くこと（2026-07-24 の実障害の回帰テスト）。
#
# 実行上の注意:
#   - トーンを実再生し、音量・既定出力デバイスを一時的に変更する（終了時に復元）。
#   - 実行中はこの Mac で音声を使わないこと（会議・音楽の最中に走らせない）。
#   - CI では動かない（音声再生が必要）。リリース前にローカルで回す用。
# =====================================================================
set -u
cd "$(dirname "$0")/.."
BIN=./native/sysrec/sysrec
TOOLS_SRC=test/tools/switch-out.swift
WORK="$(mktemp -d "${TMPDIR:-/tmp}/rmr-audio-matrix.XXXXXX")"
SWITCH="$WORK/switch-out"
PASS=0; FAIL=0

say_result() { # $1=ok|ng $2=label $3=detail
  if [ "$1" = ok ]; then PASS=$((PASS+1)); printf "  \033[32m✓\033[0m %s %s\n" "$2" "$3";
  else FAIL=$((FAIL+1)); printf "  \033[31m✗ %s %s\033[0m\n" "$2" "$3"; fi
}

# ---- 前提チェック --------------------------------------------------
[ "$(uname)" = "Darwin" ] || { echo "macOS 専用です"; exit 1; }
for c in ffmpeg ffprobe afplay swiftc; do
  command -v "$c" >/dev/null || { echo "$c が必要です"; exit 1; }
done
[ -x "$BIN" ] || { echo "sysrec がありません。先に: npm run build-sysrec"; exit 1; }
"$BIN" --version >/dev/null 2>&1 || { echo "sysrec が --version に応答しません（古い？）"; exit 1; }

# ---- 環境の保存と復元 ----------------------------------------------
swiftc -O "$TOOLS_SRC" -o "$SWITCH" 2>/dev/null || { echo "switch-out のビルドに失敗"; exit 1; }
ORIG_VOL=$(osascript -e 'output volume of (get volume settings)')
ORIG_OUT=$("$SWITCH" current || true)
restore() {
  osascript -e "set volume output volume $ORIG_VOL" >/dev/null 2>&1
  [ -n "$ORIG_OUT" ] && "$SWITCH" "$ORIG_OUT" >/dev/null 2>&1
  rm -rf "$WORK"
}
trap restore EXIT INT TERM

echo "⚠ トーンを再生し、音量と既定出力を一時変更します（終了時に復元）。3 秒後に開始…"
sleep 3

# マトリクスは内蔵スピーカー基準で行う（mic ケースはスピーカーの音をマイクが拾う前提。
# BT イヤホンが既定だとマイクに音が届かず、レベル検証にならないため）。
"$SWITCH" "BuiltInSpeakerDevice" >/dev/null 2>&1 || true
osascript -e 'set volume output volume 35' >/dev/null

# 検証済みレベルのトーン（aevalsrc: mean -23dBFS / ffmpeg の sine フィルタは -21dB しか出ないので使わない）
ffmpeg -v error -f lavfi -i "aevalsrc=0.1414*sin(2*PI*440*t):d=8:s=48000" -ac 2 -c:a pcm_s16le "$WORK/tone.wav" -y

mean_of() { # $1=file [$2=ss $3=t] → mean dBFS（数値のみ）
  # macOS 同梱 bash 3.2 は set -u で空配列の展開がエラーになるため ${arr[@]+...} で守る
  local args=()
  [ $# -ge 3 ] && args=(-ss "$2" -t "$3")
  ffmpeg -hide_banner -nostats ${args[@]+"${args[@]}"} -i "$1" -af volumedetect -f null - 2>&1 \
    | grep -o 'mean_volume: [-0-9.]*' | awk '{print $2}'
}

in_range() { # $1=val $2=min $3=max
  awk -v v="$1" -v lo="$2" -v hi="$3" 'BEGIN{exit !(v>=lo && v<=hi)}'
}

# ---- 1) レベルマトリクス（9 ケース）--------------------------------
# $1=label $2=source $3=agc $4=manual $5=sysgain $6=micgain $7=min $8=max
run_case() {
  local label="$1" source="$2" agc="$3" manual="$4" sg="$5" mg="$6" lo="$7" hi="$8"
  local base="$WORK/$label" out="$WORK/$label.m4a"
  local args=(--out "$out" --source "$source" --samplerate 24000 --channels 1
              --agc "$agc" --status-file "$base.status" --pidfile "$base.pid"
              --mic-gate -34 --sys-gate -48)
  [ "$manual" = on ] && args+=(--manual on --system-gain "$sg" --mic-gain "$mg")
  : > "$base.status"
  "$BIN" "${args[@]}" 1>/dev/null 2>"$base.log" &
  local pid=$!
  sleep 1
  afplay "$WORK/tone.wav" >/dev/null 2>&1 &
  local ap=$!
  sleep 6
  kill -TERM "$pid" 2>/dev/null; wait "$pid" 2>/dev/null; kill "$ap" 2>/dev/null

  # プラグインの停止時仕上げを再現（single/rescue→normalize・both→mix --normalize on）
  if [ "$source" = both ]; then
    if [ -s "$base.sys.m4a" ] && [ -s "$base.mic.m4a" ]; then
      "$BIN" mix --in "$base.sys.m4a" --in "$base.mic.m4a" --out "$out" \
             --agc "$agc" --normalize on --channels 1 --samplerate 24000 >/dev/null 2>&1
    fi
  else
    "$BIN" normalize --in "$out" --out "$out.norm" >/dev/null 2>&1
    local rc=$?
    if [ $rc -eq 0 ]; then mv "$out.norm" "$out"; else rm -f "$out.norm"; fi
    # rc=3（変更不要）は元ファイルのまま＝正しい挙動
  fi

  if [ ! -s "$out" ]; then say_result ng "$label" "(出力ファイルなし)"; return; fi
  local mv; mv=$(mean_of "$out")
  if [ -z "$mv" ]; then say_result ng "$label" "(計測不能)"; return; fi
  if in_range "$mv" "$lo" "$hi"; then say_result ok "$label" "(mean ${mv} dBFS)";
  else say_result ng "$label" "(mean ${mv} dBFS / 期待 [${lo}, ${hi}])"; fi
}

echo
echo "[1] レベルマトリクス（目標 -16 dBFS 近傍・トーン再生 6 秒録音 × 9）"
#         label               source  agc manual sg mg   min    max
run_case "sys_agc-on"         system  on  off    0  0   -20    -12
run_case "sys_agc-off"        system  off off    0  0   -20    -12
run_case "sys_manual+6dB"     system  off on     6  0   -20    -12
run_case "mic_agc-on"         mic     on  off    0  0   -22    -10
run_case "mic_agc-off"        mic     off off    0  0   -22    -10
run_case "mic_manual+6dB"     mic     off on     0  6   -22    -10
run_case "both_agc-on"        both    on  off    0  0   -20    -12
run_case "both_agc-off"       both    off off    0  0   -20    -12
run_case "both_manual_0dB"    both    off on     0  0   -20    -12

# ---- 2) デバイス切替の追従（2026-07-24 の実障害の回帰）--------------
echo
echo "[2] 録音中の既定出力デバイス切替 → システム音が追従して録れ続ける"
OTHER=$("$SWITCH" | grep -v '^\*' | grep -v BuiltInSpeakerDevice | head -1 | sed 's/.*\[\(.*\)\]/\1/')
if [ -z "$OTHER" ]; then
  echo "  - スキップ: 内蔵スピーカー以外の出力デバイスが無い（切替テスト不可）"
else
  # 別デバイス（例: BT イヤホン）で録音を開始 → 内蔵スピーカーへ切替 → トーン再生。
  # 「切替後の音が録れているか」だけを検証する（切替前の BT はアイドル状態次第で不安定なため）。
  "$SWITCH" "$OTHER" >/dev/null 2>&1
  sleep 0.5
  base="$WORK/devswitch"; out="$base.m4a"; : > "$base.status"
  "$BIN" --out "$out" --source system --samplerate 48000 --channels 1 --agc off \
         --status-file "$base.status" --pidfile "$base.pid" 1>/dev/null 2>"$base.log" &
  pid=$!
  sleep 2
  "$SWITCH" "BuiltInSpeakerDevice" >/dev/null 2>&1
  sleep 1.5
  afplay "$WORK/tone.wav" >/dev/null 2>&1 &
  ap=$!
  sleep 5
  kill -TERM "$pid" 2>/dev/null; wait "$pid" 2>/dev/null; kill "$ap" 2>/dev/null

  if grep -q "再接続" "$base.log"; then
    say_result ok "rebuild-log" "(sysrec が出力デバイス変更に追従した)"
  else
    say_result ng "rebuild-log" "(再接続ログなし: $(cat "$base.log" | head -1))"
  fi
  post=$(mean_of "$out" 4 3.5)
  if [ -n "$post" ] && in_range "$post" -35 0; then
    say_result ok "post-switch-audio" "(切替後の区間 mean ${post} dBFS)"
  else
    say_result ng "post-switch-audio" "(切替後の区間 mean ${post:-計測不能} dBFS / 期待 > -35)"
  fi
fi

echo
echo "=== audio-matrix: $PASS passed, $FAIL failed ==="
[ $FAIL -eq 0 ]
