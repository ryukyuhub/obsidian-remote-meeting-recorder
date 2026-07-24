## 0.9.0

### 修正（重要）

- **タイトルに `/` や `<>` 等を含むと録音がサイレント消失する問題を修正**（E2E UI-03 で検出）。ファイル名を自動サニタイズし（`定例MTG 7/25 <重要>` → `定例MTG 7-25 -重要-`）、出力ファイルが開けない場合は録音開始時点でエラーにするようにした。
- caffeinate 起因の 2 件を修正: spawn の ENOENT が未捕捉例外でプロセスごと落ちる問題／非 macOS 環境で mix・normalize が常に失敗する問題（`spawnWithSleepGuard` 導入、macOS の挙動は不変）。

### 変更

- **仕上げ正規化の目標を −16 → −14 dBFS に引き上げ**（「AGC 録音が小さい」フィードバック対応）。実会議録音の実測 −16.9 LUFS → 配信基準（≒ −14 LUFS）に合わせた。Windows 実機で +2.4dB を確認済み。同梱の `sysrec` は CI（macOS ランナー）で本タグからビルドされており **−14 適用済み**。既存の Mac 環境は doctor の「sysrec を取得」または `npm run build-sysrec` で更新のこと。
  - ⚠️ macOS 実機での回帰確認（`test:audio`・DSP 契約テスト [14]）は未実施。次回 Mac 作業時に実施予定。
- Windows: チャンネル数設定（モノラル）を実録音に反映（出力段ダウンミックス）。サンプルレート設定はビットレートにのみ反映される旨を設定画面に明記。

### 開発・品質

- 手動 E2E チェックリスト新設（`test/manual-e2e/`・7 ファイル 56 項目＋組み合わせ 11 項目）。今回のリリース前に Windows 実機で 15 項目実施（結果: `results/2026-07-25-windows-auto.md`）。
- E2E の自動駆動を確立: CDP（`dev/cdp-eval.mjs`）＋公式 Obsidian CLI で録音の開始〜停止〜検証まで人手ゼロで実行可能に。
- lint を 80 警告 → 0 に（Electron remote の型付け・activeDocument 化 等）。
- Issue #2 回答済み（AutoGain オフでもリミッター・クリップ防止は常時有効。実測エビデンス付き）。

**Full Changelog**: https://github.com/ryukyuhub/obsidian-remote-meeting-recorder/compare/0.8.0...0.9.0
