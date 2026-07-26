# 手動 E2E 結果 — 2026-07-27（Windows・ノイズゲート自動ラン）

- 実施者: Claude Code（CLI/CDP 自動駆動・人手ゼロ）
- プラグインバージョン: 0.10.1 + Windows ノイズゲート実装（未リリース・ワーキングツリー）
- OS / 機種: Windows（WSL AlmaLinux-10 から駆動）
- 実施範囲: 03-recording-windows の WIN-10（ノイズゲート）を数値検証で自動化
- きっかけ: Windows ノイズゲート実装直後の実機検証

## 結果サマリ

| テスト | 結果 | 根拠 |
|---|---|---|
| A: システムゲート有効（sysNoiseGate=-34） | OK | トーン区間 -18.8/-10.1 dB で有音、ノイズ(-50dBFS)区間 **-113.7dB/-inf**＝ゲート全閉。1 秒刻みで明瞭な矩形パターン |
| B: ゲート無効（off・対照） | OK | ノイズ区間 -18.4/-18.2 dB（AGC がノイズも持ち上げる）。A との差 **約 95dB**（合格ライン 10dB を大幅クリア） |
| C: マイクゲート スモーク（micNoiseGate=-40・無音録音） | 参考 | 静寂中盤 8 秒は -76〜-inf dB まで沈黙＝ゲート動作。冒頭末尾に環境音スパイク（-33〜-47dB）があり全体 RMS は -42.6dB |

WIN-10 のうち数値で見える部分（無音区間の抑圧・ゲート開閉）は自動検証済み。**残る耳確認は「発話の頭が切れないこと」のみ**（判定粒度 100ms のため）。

## 駆動方法（CLI 第一選択の実績）

- CLI で完結: `commands filter=remote-meeting`・`open-recording-view`・`stop-recording`
- CDP が必要: `startRecordingFromView` の直接呼び出し（start-recording はビューを開くだけ）と設定ロード値の確認

## 後始末

- data.json は元内容へ復元、テスト録音 4 本・テスト生成の Daily/2026-07-27.md（中身がテスト埋め込みのみ）・一時音源を削除、sessions 孤児なし、デバッグポート無しで通常再起動済み。

## メモ（ハーネスの落とし穴 → README に追記済み）

- PowerShell `Set-Content -Encoding utf8` は **BOM 付き**で書くため data.json が黙って読めなくなり設定がデフォルトへフォールバックする。BOM 無し書き込み必須。
- テスト音源再生は `System.Media.SoundPlayer.PlaySync()`（WAV・同期）が正確。`MediaPlayer` は再生時間が不安定（20 秒音源で 46 秒録音になる事例）。
- 合成音源テストでは `transcribeOnStop: false` にする（whisper が非音声に幻覚出力するため・想定内挙動）。
