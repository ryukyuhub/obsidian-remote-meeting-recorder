# CLAUDE.md

このファイルは Claude Code がこのリポジトリで作業する際のガイドです。**作業前に必ず設計書を参照**してください。

## プロジェクト概要

Obsidian デスクトップ向け**リモート会議録音プラグイン**（plugin id: `remote-meeting-recorder`）。
macOS のシステム音声（＝会議相手の声）とマイクを同時録音し、**録音データを絶対に失わない**堅牢さで、Obsidian ノート／文字起こしに直結させる。

- 対象環境: macOS 15+（開発機 macOS 26.5 arm64）/ Node v24 / esbuild / TypeScript、録音バイナリは swiftc。
- 現状: **greenfield（コード未生成）**。設計フェーズ完了、実装は Phase 0 から着手待ち。

## 必読ドキュメント（単一の真実の源）

| ドキュメント | 役割 |
|---|---|
| `リモート会議録音プラグイン 設計書.md` | **最重要**。アーキテクチャ・モジュール・UI・堅牢性・文字起こし・Phase の全定義 |
| `Obsidian録音プラグイン向け 録音ノウハウレポート.md` | candypi 会議録音MCP の運用実績（実装知見の出典） |
| `~/.claude/plans/obsidian-steady-hinton.md` | 承認済み実装計画（Phase 0–3） |
| `/Users/candy/www/candypi/native/sysrec/` | 流用元の録音バイナリ `sysrec.swift` / `build.sh` / `sysrec.entitlements` |
| `/Users/candy/www/candypi/src/connectors/meeting-recorder/` | セッション状態機械の出典（recipes.ts / tools.ts） |

## アーキテクチャ要点（詳細は設計書）

- **録音エンジンは外部ヘルパー `sysrec`**（Swift / ScreenCaptureKit）。Electron/Chromium だけでは macOS のシステム音声を確実に録れないため（設計書 §2・独立した参考プラグイン 2 本でも実証済み §14/§16）。
- **状態機械（start/stop/sweep/remix）は TypeScript + `child_process`/`fs`** で再実装。**真実の源はファイルシステム**（`~/.meeting-recorder/`）——sysrec はレンダラより長生きするため状態はメモリに置かない。`onunload` で録音を殺さない。
- **堅牢性が最優先**: 起動検証してから JSON を書く／孤児 sweep で中間ファイルを温存／mix 失敗は `stop-warning`→remix 復旧／片系だけなら rename で救う（設計書 §5/§6）。
- **文字起こしはローカル Whisper サーバ（MLX）**。アーカイブ m4a（高品質）と 16kHz mono PCM（文字起こし用）を分離（設計書 §15）。
- **Phase 0–3 = 録音堅牢性（v1）**、Phase 4 = 録音ビュー拡充／ホットキー／ミニ制御ウィンドウ、Phase 6–7 = 文字起こし（一括→リアルタイム）。

## ビルド・コマンド（scaffold 後に有効）

| コマンド | 用途 |
|---|---|
| `npm run dev` | esbuild watch |
| `npm run build` | 型チェック＋本番ビルド（main.js） |
| `npm run build-sysrec` | `sysrec` バイナリをローカルビルド（`native/sysrec/build.sh`） |
| `npm run test:e2e` | ニセバイナリ E2E（`test/e2e.mjs`） |

テスト vault へは `ln -s <repo> <vault>/.obsidian/plugins/remote-meeting-recorder` でシンボリックリンク。

## 規約

### 日本語対応

- **ドキュメント・コード内コメント・コミットメッセージ・UI 文言・Notice・ログは日本語**で書く。
- ただし**識別子（変数 / 関数 / 型 / ファイル名）は英語**（可読性・慣習優先）。
- 設計書・README も日本語で維持する。

### サブエージェント運用（トークン節約）

- **E2E 系の作業**（実機 E2E、fake-binary E2E、Obsidian 起動確認、録音の駆動・検証、`verify` 相当）と、**Web 検索・外部調査系の作業**（WebSearch、参考プラグイン調査、外部ドキュメント収集、GitHub リポジトリ調査）は、**Sonnet のサブエージェントに委譲**してメインのトークンを節約する。
  - 例: `Agent(subagent_type: "general-purpose", model: "sonnet", …)`、探索は `Agent(subagent_type: "Explore", model: "sonnet", …)`。
  - サブエージェントには**結論（要点・差分・可否）だけを返させ**、生ログやファイル全文をメインに持ち込まない。
- 逆に、**設計判断・アーキテクチャの決定・状態機械やコアロジックの実装**はメイン（Opus）で行う。

## 作業の進め方

- 大きな変更の前に設計書の該当 Phase / セクションを確認し、逸脱する場合はユーザーに相談する。
- 実装は Phase 単位で進め、各 Phase 末に設計書の「到達点」で検証する（設計書 §12）。
- ユーザーが「実装開始」と言うまでコード生成しない方針で進めてきた経緯がある——スコープはユーザー確認を優先。
