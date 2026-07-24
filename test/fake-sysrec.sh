#!/bin/sh
# sysrec 契約再現スタブ（実録音なし・E2E 用）。
#   版数: --version → {"abi":N,"version":"..."}（プラグインの互換チェック）
#   録音: --out <p> --source <both|system|mic> --pidfile <p> --status-file <p> [他は無視]
#   ミックス: mix --in <sys> --in <mic> --out <final> [--agc ...] [--channels 1|2]
#   正規化: normalize --in <file> --out <file>（exit 3 = 変更不要でスキップ）
# 環境変数: FAKE_NO_PIDFILE=1（pidfile を書かない=起動失敗）/ FAKE_MIX_FAIL=1（mix を失敗）
#           FAKE_NORMALIZE_FAIL=1（normalize を失敗）
#           FAKE_NORMALIZE_UNCHANGED=1（変更不要=exit 3 を再現）
#           FAKE_OLD_BINARY=1（--version を知らない旧バイナリを再現）

# ---- 版数申告 ----
# 旧バイナリは --version を解さず die する。それを FAKE_OLD_BINARY で再現できるようにする。
if [ "$1" = "--version" ] || [ "$1" = "version" ]; then
  if [ "$FAKE_OLD_BINARY" = "1" ]; then
    echo "sysrec: --out <path> は必須です。" >&2
    exit 1
  fi
  echo '{"abi":2,"version":"0.6.1-fake"}'
  exit 0
fi

emit() { # $1=status-file $2=json行
  printf '%s\n' "$2"
  [ -n "$1" ] && printf '%s\n' "$2" >>"$1"
}

# ---- mix サブコマンド ----
if [ "$1" = "mix" ]; then
  shift
  OUT=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --out) OUT="$2"; shift 2 ;;
      --in|--agc|--normalize|--channels) shift 2 ;;
      *) shift ;;
    esac
  done
  if [ "$FAKE_MIX_FAIL" = "1" ]; then
    echo "sysrec: fake mix 失敗" >&2
    exit 1
  fi
  printf 'fake-mixed-audio\n' >"$OUT"
  echo '{"bytes":16,"durationSec":3,"event":"mixed","path":"'"$OUT"'"}'
  exit 0
fi

# ---- normalize サブコマンド ----
if [ "$1" = "normalize" ]; then
  shift
  IN=""; OUT=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --in) IN="$2"; shift 2 ;;
      --out) OUT="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  if [ "$FAKE_NORMALIZE_FAIL" = "1" ]; then
    echo "sysrec: fake normalize 失敗" >&2
    exit 1
  fi
  if [ "$FAKE_NORMALIZE_UNCHANGED" = "1" ]; then
    # 変更不要: 出力を書かずに 3。呼び出し側は元ファイルをそのまま使う。
    echo "normalize: 変更不要（0.0 dB）" >&2
    exit 3
  fi
  # 実処理の代わりに「印を付けてコピー」（差し替えが起きたことを検証できるようにする）
  { cat "$IN"; printf 'fake-normalized\n'; } >"$OUT"
  echo '{"bytes":16,"durationSec":3,"event":"normalized","normGainDb":6,"path":"'"$OUT"'"}'
  exit 0
fi

# ---- 録音モード ----
OUT=""; SOURCE="both"; PIDFILE=""; STATUS=""
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="$2"; shift 2 ;;
    --source) SOURCE="$2"; shift 2 ;;
    --pidfile) PIDFILE="$2"; shift 2 ;;
    --status-file) STATUS="$2"; shift 2 ;;
    --samplerate|--channels|--agc|--mic-device) shift 2 ;;
    *) shift ;;
  esac
done

BASE="${OUT%.*}" # deletingPathExtension 相当

finalize() {
  if [ "$SOURCE" = "both" ]; then
    printf 'fake-sys\n' >"${BASE}.sys.m4a"
    printf 'fake-mic\n' >"${BASE}.mic.m4a"
    emit "$STATUS" '{"durationSec":3,"event":"stopped","parts":{"mic":"'"${BASE}.mic.m4a"'","system":"'"${BASE}.sys.m4a"'"},"source":"both"}'
  else
    printf 'fake-single\n' >"$OUT"
    emit "$STATUS" '{"bytes":12,"durationSec":3,"event":"stopped","path":"'"$OUT"'","source":"'"$SOURCE"'"}'
  fi
  exit 0
}

trap finalize TERM INT

# pidfile（起動ハンドシェイク）
if [ "$FAKE_NO_PIDFILE" != "1" ] && [ -n "$PIDFILE" ]; then
  printf '%s' "$$" >"$PIDFILE"
fi

# started
emit "$STATUS" '{"event":"started","pid":'"$$"',"source":"'"$SOURCE"'"}'

# FAKE_NO_PIDFILE のときは何も録らず即終了（起動失敗を再現）
[ "$FAKE_NO_PIDFILE" = "1" ] && exit 1

# 停止シグナル待ち（trap を効かせるため sleep を wait で割り込み可能に）
while :; do
  sleep 0.3 &
  wait $!
done
