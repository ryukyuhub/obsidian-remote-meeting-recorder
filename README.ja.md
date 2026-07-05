# Remote Meeting Recorder — 日本語ドキュメント

Obsidian デスクトップ（macOS 専用）向けの**リモート会議録音プラグイン**です。
**システム音声（＝会議相手の声）**と**マイク**を同時に録音し、クラッシュや
リロードをまたいでも録音データを失わない堅牢さで、音声と（任意で）ローカル
文字起こしをノートに直結させます。

English documentation: [README.md](README.md)

## なぜ外部ヘルパーバイナリが必要か

Electron/Chromium だけでは macOS のシステム音声を確実に録れないため、録音は
Apple の **Core Audio プロセスタップ** を使う小さな外部ヘルパー `sysrec`（Swift）が担当
します。プラグインはこれをサブプロセスとして起動し、真実の源をファイルシステム
（`~/.meeting-recorder/`）に置くので、Obsidian のリロードやクラッシュがあっても
録音中のセッションを復元できます。**プレビルドのバイナリは同梱も配布もせず**、
本リポジトリのソースから各自ビルドします（[インストール](#インストール)参照）。

## 主な機能

- **システム音声＋マイク**の同時録音（片方だけも可）。
- **クラッシュ耐性**: リロード・クラッシュ・蓋閉じの後でも録音を復元して最終化。
  `onunload` で録音を止めません。
- 2 トラックの自動オフライン **mix**（1 本の m4a）。失敗時は **remix** 復旧、片系
  のみなら rename で救済。
- **ライブ波形**と常時前面のミニ制御ウィンドウ（会議アプリを離れず停止可能）。
- **停止時にノートへ埋め込み**（`![[録音.m4a]]` を選んだノートに挿入）。
- 同梱ビルドの [whisper.cpp](https://github.com/ggerganov/whisper.cpp) による
  **ローカル文字起こし**（完全オフライン）。
- バイナリ・権限・デバイス・文字起こし設定を確認する**診断（doctor）**パネル。

## 動作要件

- **macOS**（Core Audio プロセスタップ。macOS 14.4 以降。開発は macOS 15/26・Apple Silicon）。
  デスクトップ専用。
- `sysrec` をビルドするための **Xcode コマンドラインツール**（`swiftc`）。
- 文字起こし（任意）: `whisper-cpp`（`brew install whisper-cpp`）または
  `npm run build-whisper`、および ggml モデル（doctor から取得可能）。
- Obsidian への**マイク権限**（初回録音時に macOS が確認）。画面収録権限は不要です。

## インストール

本プラグインは（macOS ネイティブヘルパーに依存するため）公式ストア外での配布です。
**BRAT** かソースからインストールします。どちらの場合も `sysrec` ヘルパーを一度
ビルドします。

### BRAT で導入（推奨）

Xcode もターミナルも不要 — `sysrec` ヘルパーはワンクリックで取得できます。

1. コミュニティプラグイン **BRAT** を導入。
2. BRAT の「Add a beta plugin」に本リポジトリを追加:
   `ryukyuhub/obsidian-remote-meeting-recorder`。BRAT が最新リリースから
   `main.js` / `manifest.json` / `styles.css` を取得します。
3. プラグインを有効化し、設定の**診断（doctor）**を開く。`sysrec` が無ければ
   **「sysrec を取得」**をクリック — 最新リリースから ad-hoc 署名済みヘルパーを
   ダウンロードして配置します。
4. 求められたら Obsidian に**マイク**権限を付与。

同梱の `sysrec` は ad-hoc 署名（未公証）です。HTTPS で取得され Obsidian から
サブプロセスとして起動されます。この経路では Gatekeeper のダイアログは出ず、
doctor がダウンロード後に隔離属性を除去します。

### ソースから

1. Vault のプラグインフォルダに clone（または別の場所に clone してシンボリック
   リンク）:

   ```sh
   git clone https://github.com/ryukyuhub/obsidian-remote-meeting-recorder.git
   cd obsidian-remote-meeting-recorder
   npm install
   npm run build            # main.js を生成
   npm run build-sysrec     # sysrec ヘルパーをビルド（要 swiftc）
   ```

2. `<vault>/.obsidian/plugins/remote-meeting-recorder` に配置（またはリンク）。

3. Obsidian → 設定 → コミュニティプラグイン で **Remote Meeting Recorder** を有効化。

4. プラグイン設定の**診断（doctor）**でバイナリ・権限・（任意で）文字起こしを確認。

5. 求められたら Obsidian に**マイク**権限を付与（システム設定 → プライバシーと
   セキュリティ → マイク）。システム音声は Core Audio タップで取得するため画面収録
   権限は不要です。

## 使い方

1. **Remote Meeting Recorder** ビューを開く（リボンアイコン or コマンド）。
2. ソース（システム/マイク/両方）、保存先、埋め込み先ノートを選ぶ。
3. 参加者同意のチェックを入れて**録音**を押す。
4. **停止**（ビュー or ミニ制御ウィンドウ）。録音が保存され、ノートに埋め込まれ、
   有効ならローカルで文字起こしされます。

ファイルエクスプローラでノートを右クリック →**「ここに会議録音を埋め込む」**でも、
そのノートを埋め込み先にして録音を始められます。

## 開発

```sh
npm install
npm run build-sysrec     # sysrec ヘルパーをビルド（要 swiftc / macOS）
npm run dev              # esbuild watch（root に main.js を生成）
npm run build            # 型チェック + 本番ビルド
npm run lint             # eslint（Obsidian の審査チェックを再現）
npm run test:e2e         # ニセバイナリ E2E（実録音なし）
```

## ライセンス

[MIT](LICENSE) © Ryukyu HUB Inc.
