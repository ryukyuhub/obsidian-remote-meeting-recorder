# Remote Meeting Recorder

Obsidian デスクトップ向け**リモート会議録音プラグイン**（macOS 専用）。

macOS のシステム音声（＝会議相手の声）とマイクを同時録音し、**録音データを絶対に失わない**堅牢さで、Obsidian ノートに直結させます。録音エンジンは ScreenCaptureKit を使う外部ヘルパー `sysrec`（Swift）です。

> 設計の詳細は `リモート会議録音プラグイン 設計書.md` を参照してください。

## 開発セットアップ

```sh
npm install              # 依存インストール
npm run build-sysrec     # 録音バイナリ sysrec をローカルビルド（要 swiftc / macOS）
npm run dev              # esbuild watch（main.js を生成）
npm run build            # 型チェック + 本番ビルド
npm run test:e2e         # ニセバイナリ E2E（実録音なし）
```

テスト Vault へのリンク:

```sh
ln -s "$(pwd)" <vault>/.obsidian/plugins/remote-meeting-recorder
```

Obsidian で「Remote Meeting Recorder」を有効化し、設定タブの「診断を実行（doctor）」でセットアップ状態を確認できます。

## 権限（macOS）

初回録音時に Obsidian への画面収録許可ダイアログが出ます。
「システム設定 > プライバシーとセキュリティ > 画面収録」で Obsidian を許可してください
（`--source mic` でも内部で ScreenCaptureKit を開くため画面収録権限が必要です）。

> MacBook の蓋を閉じるとスリープし録音は止まります。

## 実装フェーズ

- **Phase 0**（現在）: scaffold + 診断（doctor）+ native バイナリのビルド導線
- Phase 1: 録音ビュー + 単一ソース（system / mic）録音・停止・埋め込み
- Phase 2: both 録音 + オフライン mix + mix 失敗からの remix 復旧
- Phase 3: reload / 再起動をまたぐセッション復元

## ライセンス

MIT
