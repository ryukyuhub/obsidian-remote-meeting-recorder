# 手動 E2E 結果 — 2026-07-29（Windows・0.11.4 リリース前スモーク）

- 実施者: Claude Code（CLI 自動駆動・SMK-02 のみユーザー目視）
- プラグインバージョン: 0.11.3 + Smart App Control 状態検査（79b6e19・未リリース）
- OS / 機種: Windows 10.0.26200（WSL AlmaLinux-10 から駆動・Vault は G: の Google Drive）
- 実施範囲: 01-smoke（自動化可能分＋SMK-02 目視）
- きっかけ: 0.11.4 リリース前（診断への Smart App Control 検査追加）

## 結果サマリ

| 項目 | 結果 | 根拠 |
|---|---|---|
| SMK-01 プラグイン読込 | OK | CLI `commands filter=remote-meeting` が全 6 コマンドを返答 |
| SMK-02 doctor 全OK | OK | ユーザー目視（スクリーンショット）。7 項目 OK/INFO、環境起因の [WARN] は新設の Smart App Control（この機種は強制モードのため想定どおり）のみ |
| SMK-03 both 録音→停止 | OK | CLI eval で開始→440Hz トーン再生→停止。`RMR/2026-07-29-2247.m4a` 30.8 秒、mean -18.1dB / max 0.0dB（無音でない）。20 秒との差 +10.8 秒は WSL→PowerShell→CLI 往復の壁時計と一致＝駆動オーバーヘッドであり録音エンジンのドリフトではない |
| SMK-04 ノート埋め込み | OK | 停止後、テストノートに `![[RMR/2026-07-29-2247.m4a]]` が追記 |
| SMK-05 状態ファイル後始末 | OK | 停止後 `sessions/` 空。.pid/.status/.control/.level・中間 sys/mic 残存なし |
| SMK-06 文字起こし1件 | スキップ | 本機は Smart App Control 強制モードで OS 警告が出るため今回スコープ外。本リリースは文字起こしパイプライン非変更（診断のみ） |

## スキップした項目と理由

- SMK-06: 上表のとおり。TRN-11（SAC ブロック時の案内）は 0.11.3 で追加済みの項目であり、本機では「exe 起動は通り DLL だけブロックされる」変種のため NG 表示の再現機としては不適。新設の SAC 検査が [WARN] を出すことは SMK-02 で目視確認済み。

## 後始末

- テスト録音・テストノートは完全削除、`linkToDailyNote` で追記された Daily/2026-07-29.md は元内容（byte 一致）へ復元、data.json 不変、一時ファイル（トーン wav・ps1）削除、残存プロセスなし。デバッグポート再起動は不使用（CLI のみ）。

## メモ

- 本機の SAC は whisper-cli.exe の起動を許しつつ ggml-cpu-haswell/sse42.dll のロードだけをブロックする（CodeIntegrity 3033/3077 で実測）。0.11.3 の起動プローブでは [OK]（起動確認済み）になる変種で、これが 0.11.4 のレジストリ検査を追加した動機。
