# 手動 E2E 結果 — 2026-07-24（WSL・自動テストのみ）

- 実施者: Claude Code（自動テストのみ。手動項目は未実施）
- プラグインバージョン: 0.3.1
- OS / 機種: WSL2（Windows 開発機）
- 実施範囲: 前提の自動テスト一式（`test:e2e` / `build` / `lint`）。手動チェックリスト（01〜07）は実機・人の確認が必要なため未実施。
- きっかけ: チェックリスト新設に伴う初回実行

## 結果サマリ

| 対象 | 結果 |
|---|---|
| `npm run test:e2e` | **68 passed / 0 failed**（DSP契約 [14] は実バイナリなしのためスキップ。macOS で `build-sysrec` 後に要確認） |
| `npm run build` | 成功 |
| `npm run lint` | 成功（0 errors / 80 warnings） |

## 発見・修正したバグ（2件）

初回実行はクラッシュ→10件FAIL。いずれも「macOS 専用コマンド `caffeinate` が Linux/WSL に無い」ことが原因で、修正済み:

1. **`src/recorder/spawn.ts` `spawnCaffeinate()`**: spawn の ENOENT は非同期 `error` イベントで届くためハンドラが無いと未捕捉例外でプロセスごと落ちる → `child.on("error", ...)` を追加。
2. **`src/recorder/mix.ts`**: mix / normalize を `caffeinate -i <bin> …` でラップしていたため WSL では常に失敗（mix→stop-warning 化、normalize 不発）→ `spawnWithSleepGuard` を導入し、darwin のみ caffeinate でラップ、他は直接 spawn。

## メモ

- WSL では `test:e2e` が常時完走できるようになった。今後は WSL でも前提テストとして実行可能。
- 手動チェックリストの初回実施は未了: Windows 実機（G: マウント→コピー→リロード後）と Mac 実機での実施が必要。
