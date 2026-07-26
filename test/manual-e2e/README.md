# 手動 E2E テスト（実機チェックリスト）

自動テスト（`npm run test:e2e` / `npm run test:audio`）ではカバーできない**実機依存の挙動**を確認するためのチェックリスト集。バグの再発防止のため、下記のタイミングで定期的に実施する。

## ファイル構成

| ファイル | 内容 | 所要時間 | 対象機 |
|---|---|---|---|
| [01-smoke.md](01-smoke.md) | 最小限のスモークテスト | 約5分 | macOS / Windows |
| [02-recording-macos.md](02-recording-macos.md) | macOS 録音（sysrec / Core Audio タップ） | 約20分 | macOS |
| [03-recording-windows.md](03-recording-windows.md) | Windows 録音（Web Audio 経路） | 約15分 | Windows |
| [04-robustness.md](04-robustness.md) | 堅牢性（クラッシュ復旧・remix・sweep） | 約15分 | macOS 中心 |
| [05-transcription.md](05-transcription.md) | 文字起こし（whisper.cpp） | 約15分 | macOS / Windows |
| [06-ui-settings.md](06-ui-settings.md) | UI・設定タブ・埋め込み | 約15分 | macOS / Windows |
| [07-combinations.md](07-combinations.md) | 複数設定の組み合わせ（相互作用） | 約20分 | macOS / Windows |

## 実施タイミング

| タイミング | 実施範囲 |
|---|---|
| **リリース前（version bump 前）** | 01-smoke（必須）＋変更した機能に該当するファイル |
| **録音エンジン変更後**（sysrec / webCapture / mix / normalize） | 02 or 03 の全項目＋04 |
| **文字起こし変更後** | 05 の全項目 |
| **複数領域にまたがる変更・リファクタ後** | 07-combinations の該当項目 |
| **月次（大きな変更がなくても）** | 01-smoke を両OSで |
| **四半期に1回** | 07-combinations の全項目 |

先に自動テスト `npm run test:e2e` が全パスしていることを前提とする（状態機械の回帰は自動側で検出する）。

## 実施方法

1. 該当チェックリストの項目を上から実施し、チェックを付ける。
2. 結果は `results/TEMPLATE.md` をコピーして `results/YYYY-MM-DD-<os>.md` として記録する（NG項目は再現手順・ログを添える）。
3. NG が出たら、修正後に**該当項目だけ**再実施して結果ファイルに追記する。

## 前提環境（2環境で実施）

このプロジェクトは **Windows（WSL 開発）** と **Mac** の2環境で開発しており、E2E は**両方の実機 Obsidian** で実施する。

- **Windows**: ソースコードは WSL 上にあるが、**テストは Windows 側の Obsidian** で行う。ビルド後に main.js / styles.css / manifest.json を G: の vault へコピー→Obsidian リロード（ビルドフローで自動化済み。G: のマウントはユーザ操作）。対象: 01 / 03 / 05 / 06 / 07 の `[win]`・無印項目。
- **macOS**: macOS 14.4+（Core Audio プロセスタップ必須）。`npm run build-sysrec` 済み。テスト vault にシンボリックリンク（`ln -s <repo> <vault>/.obsidian/plugins/remote-meeting-recorder`）。対象: 01 / 02 / 04 / 05 / 06 / 07 の `[mac]`・無印項目。
- 共通: 実音声の再生ができること（音楽/動画）。マイクが接続されていること。

各項目の対象OSは、ファイル単位（02=Mac、03=Windows）または項目末尾のタグ（`[mac]` / `[win]`、無印=両OS）で判別する。

## CDP による自動駆動（Claude が録音テストを自走できる・2026-07-25 実証済み）

耳での確認が不要な録音フロー系の項目は、Obsidian を `--remote-debugging-port=9222` 付きで起動すれば **Claude Code が CDP 経由で自走できる**（`dev/cdp-eval.mjs`）。実証済みの一連の流れ:

1. `Obsidian.exe --remote-debugging-port=9222 "obsidian://open?vault=<vault>"` で起動（テスト時のみ。終了後は通常起動に戻す）
2. `open-recording-view` コマンドで録音ビューを開く（`start-recording` コマンドは**ビューを開くだけ**で録音は始まらない）
3. ビューの `vSource` 等の値を渡して `plugin.startRecordingFromView({...})` を直接呼ぶと録音開始
4. テスト音源は PowerShell の `System.Media.SoundPlayer.PlaySync()`（WAV・同期ブロッキング）で再生してループバックに流す。`System.Windows.Media.MediaPlayer` は再生時間が不安定（20 秒音源で 46 秒録音になった実例・2026-07-27）なので使わない
5. `stop-recording` コマンドで停止 → ffmpeg（`~/.meeting-recorder/bin/ffmpeg.exe`）でチャンネル・レベル検証、sessions 後始末・ノート埋め込み・文字起こし挿入をファイルで確認

自動駆動の落とし穴（2026-07-27 のゲート自動ランで確立）:

- **data.json を PowerShell で書き換えるときは BOM 無し必須**。`Set-Content -Encoding utf8` は BOM 付きで書き、Obsidian の `JSON.parse` が失敗して `loadData()` が黙って `undefined` を返し、**設定が全てデフォルトへフォールバックする**（エラー表示なし）。`[System.Text.UTF8Encoding]::new($false)` で書くこと。書き換えは Obsidian を閉じてから・元内容の退避も忘れずに。
- 合成音源（トーン/ノイズ）のテストでは `transcribeOnStop: false` にしておく（whisper が非音声入力へ幻覚的な文字起こしを出す・既知特性）。

### 公式 Obsidian CLI（2026-07-25 導入済み・第一選択）

Windows 開発機には公式 CLI をセットアップ済み（設定 → 一般 →「コマンドラインインターフェース」オン＋PATH 登録済み。実体は `C:\Users\kyan\AppData\Local\Programs\Obsidian\Obsidian.com`）。**デバッグポート付き再起動なしで**通常起動の Obsidian に対してコマンドを実行できる:

```
obsidian commands filter=remote-meeting          # プラグインコマンド一覧
obsidian command id=remote-meeting-recorder:stop-recording
obsidian vault=<name> <コマンド>                  # vault 明示（既定はアクティブ vault）
```

使い分け: **コマンド実行だけなら CLI**（手軽・通常起動のまま）、**内部状態の検証や `startRecordingFromView` の直接呼び出しが要るなら CDP**（`--remote-debugging-port=9222` で再起動が必要）。PATH 反映前のシェルや WSL インターオプからはフルパスで実行する。
