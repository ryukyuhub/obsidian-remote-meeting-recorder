#!/bin/sh
# whisper.cpp をローカルビルドして native/whisper/whisper-cli を生成する。
# 要: git / cmake（無ければ `brew install cmake`）。Apple Silicon は Metal/BLAS を自動検出。
#
#   sh build.sh            … clone + build → ./whisper-cli
#
set -e
cd "$(dirname "$0")"

REPO_DIR="whisper.cpp"

if ! command -v cmake >/dev/null 2>&1; then
  echo "[whisper] cmake が必要です。'brew install cmake' を実行してください。" >&2
  exit 1
fi

if [ ! -d "$REPO_DIR" ]; then
  echo "[whisper] cloning whisper.cpp"
  git clone --depth 1 https://github.com/ggerganov/whisper.cpp "$REPO_DIR"
fi

cd "$REPO_DIR"
echo "[whisper] building (Metal/BLAS 自動検出)"
cmake -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j --config Release
cd ..

cp "$REPO_DIR/build/bin/whisper-cli" ./whisper-cli
chmod +x ./whisper-cli
echo "[whisper] done: $(pwd)/whisper-cli"
echo "[whisper] モデル取得（診断からも可）:"
echo "  sh $REPO_DIR/models/download-ggml-model.sh large-v3-turbo-q5_0"
echo "  mkdir -p models && mv $REPO_DIR/models/ggml-large-v3-turbo-q5_0.bin models/"
