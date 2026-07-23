# Windows 対応 実装計画（Web Audio 経路）

> [!info] 決定事項（2026-07-04）
> このプラグインを **Windows でも使えるようにする**。方式は設計書 §14.6 が示す 2 択のうち
> **「Web Audio 経路（`getDisplayMedia` ループバック・バイナリ不要）」**を採用する。
> 判断軸は **ユーザーの導入の簡単さ**（exe 同梱・SmartScreen 警告・ffmpeg 依存を持ち込まない）。
> もう一方の winrec（.NET8+NAudio ネイティブ）は候補としては有力だが、candypi 実機検証
> （2026-06-28）で ffmpeg 依存・SmartScreen・未解決の音ズレバグ（R-7）等の導入摩擦が確認されており、
> 「導入の簡単さ」軸では不採用。堅牢性（Obsidian クラッシュ耐性）を最優先に切り替える場合のみ再検討する。

## 0. 背景と設計方針

macOS 版は **外部ヘルパー `sysrec`（Swift/ScreenCaptureKit）** がシステム音声を録り、TypeScript の
状態機械が「ファイルシステムを真実の源」として堅牢に管理する（sysrec はレンダラより長生き）。

Windows では Chromium/Electron が**システム音声（ループバック）をネイティブに取れる**ため、
外部バイナリ無しでレンダラ内録音が可能。その代わり録音は**レンダラ内に生き、Obsidian が閉じる／
クラッシュすると止まる**（＝合意済みのトレード）。

したがって **録音の「真実の源」を OS 別に二系統化**する：

| | macOS（既存） | Windows（新規） |
|---|---|---|
| 録音実体 | 外部 `sysrec` プロセス | レンダラ内 `MediaRecorder` |
| 生存確認 | pid（`process.kill(pid,0)`）＋ status-file | `WebRecorder` のインメモリ状態＋イベント |
| 停止 | SIGTERM → status-file の `stopped` | `MediaRecorder.stop()` の `onstop` |
| システム音声 | ScreenCaptureKit | `getDisplayMedia` ループバック |
| クラッシュ耐性 | 再起動をまたいで復元（restore/sweep） | **非対応**（チャンク逐次追記で中断耐性のみ） |

合流点 `handleTerminal`（埋め込み・デイリーノート・文字起こし）は**共通のまま流用**する。

## 1. 調査で確定した技術判断

### 1.1 システム音声キャプチャ = 方式C（確実）
- **メインプロセス**の `session.setDisplayMediaRequestHandler((req,cb)=>cb({ video: source, audio: 'loopback' }))` を
  登録し、**レンダラ**で `navigator.mediaDevices.getDisplayMedia({ video:true, audio:true })` を呼ぶ。
- `audio:'loopback'` は Electron 公式拡張。**ピッカーを出さずに**プログラムからソース確定可能。
- **Obsidian 同梱の Electron 39 系は WASAPI ループバックをネイティブ実装済み**（追加パッチ不要）。
- 方式A（`desktopCapturer.getSources`＋`getUserMedia(mandatory chromeMediaSource)`／codyklr 実装）は
  Windows でレンダラクラッシュ報告（electron#46369）があり第一候補にしない。**ただし W0 で両方試す**。
- 課題: `setDisplayMediaRequestHandler` は**メインプロセスの session** が要る。プラグイン（レンダラ）からは
  `@electron/remote` 経由でのアクセス可否を **W0 で実機検証**する（ここが本計画最大の未知数）。

### 1.2 録音フォーマット
- `MediaRecorder` の **webm/opus は Obsidian 埋め込みで seek 不可・失敗報告**があり体験が今ひとつ。
- **`audio/mp4`(AAC=m4a) が使えれば優先**（Obsidian 埋め込みが良好）。`MediaRecorder.isTypeSupported('audio/mp4')`
  を **W0 で実機判定**し、可なら mp4、不可なら webm/opus にフォールバック。
- 中断耐性: `MediaRecorder` を **timeslice 付きで start し、`ondataavailable` ごとにディスクへ逐次追記**。
  強制終了されても直近までのチャンクは概ね再生可能（webm は remux で救えるケースが多い）。

### 1.3 文字起こし・埋め込みは無改修で流用
- `transcribe/pcm.ts` は **ブラウザ `decodeAudioData` でデコード**するのでフォーマット非依存。
  webm/opus / mp4 をそのまま文字起こしに流せる（**ffmpeg 不要**）。
- 埋め込み（`embed.ts`/`dailyNote.ts`）は拡張子非依存（`![[...]]` を組むだけ・実描画は Obsidian コア）。
- `.m4a` 決め打ちは **`recorder/start.ts:resolveOutPath` と `util/fsx.ts:intermediatePaths` の 2 箇所のみ**。

## 進捗（2026-07-05）

- ✅ **W0 疎通スパイク**：実機合格。remote=OK / 方式C=OK（"System audio" 取得・ピッカー無し）/ 方式A=OK / マイク=OK / `audio/mp4`=OK（→ Windows でも `.m4a` 出力）。
- ✅ **W1 レンダラ録音エンジン**：`src/recorder/webCapture.ts`（`WebRecorder` + `pickAudioFormat`）新設。
- ✅ **W2 状態機械の win32 分岐**：`types.ts`（platform union）/ `start.ts`（resolveOutPath 拡張子引数）/ `watch.ts`（win32 は poll しない）/ `restore.ts`（win32 中断分の後始末）/ 新規 `startWeb.ts` / `main.ts`（起動・停止・onunload・レベル・復元通知の分岐）。
- ✅ **W3 診断＋説明**：`diagnostics.ts` に `windowsDoctor`（macOS 専用 NG を撤廃）、`manifest.json` の説明更新。
- ✅ **実機テスト**：Windows 実機で録音成功（2026-07-05）。診断も全項目グリーン（whisper 除く）。録音の核心は完成。
- 🔨 **W4（実装済み・実機未検証）**：`resolveWhisperBin` を Windows 対応（`whisper-cli.exe`＋`Release/` 候補＋native/whisper 浅い走査）。診断に「Windows 版 whisper を取得」導線（`ggml-org/whisper.cpp` の `whisper-bin-x64.zip` を `latest/download` から curl→tar 展開＝`Release/whisper-cli.exe`）。whisper メッセージも Windows 向けに修正。※VC++ 再頒布可能パッケージの要否は未確認（DLL 起動エラー時に案内）。
- ⏳ **詰め（任意）**：マイクデバイス選択（win32 は `navigator.mediaDevices.enumerateDevices` 化）／音量バランス。

## 進捗（2026-07-23・Issue #4 対応）

Windows で「録音は進むのに中身が無音」の報告（Issue #4）を受けての調査と対処。

### 分かったこと
- **AutoGain(AGC) が Windows では完全な no-op だった**：`agc` が `WebRecorderOptions` に無く、`startWeb.ts` でセッション JSON に記録されるだけ。マイクは Chromium の `autoGainControl: true` 固定、システム音（ループバック）は無加工、保存時の正規化も無し＝**レベル補正が一段も無い**状態だった。
- 手動ミキサー ON・0 dB は非手動と完全に同一のグラフ（`dbToLinear(0)=1`）。手動ミキサー自体は無音の原因になり得ない。
- 症状の実測（報告者）：メーターが両方とも振れない／`.m4a` の長さは正常で中身だけ無音／source=both／録音ビューのボタンから開始。⇒ **Web Audio グラフに音が入っていない**。
- 7/05 の実機成功以降、Windows 録音パスへの変更は 67f2f74（ソース別ゲイン/メーター・**Windows 実機未検証**）のみ。

### 入れた対処
- **ノードの GC 対策**：このグラフは `source → gain → MediaStreamDestination` で `ctx.destination` に繋がらないため、Web Audio の「出力に繋がるノードは保持される」規則が効かない。ソースノード／ラッパー MediaStream／dest をローカル変数から `this` の保持へ変更（回収されるとグラフが黙って無音になるため）。
- **AudioContext の resume**：生成後に `resume()`、running にならなければ起動失敗。録音中に suspended へ落ちたら自動復帰。
- **無音ウォッチ**：開始から 5 秒レベルが 0 のままなら Notice で警告（長時間録ってから気づく事態を防ぐ）。
- **AutoGain を Windows でも実装**（macOS の `AGCProcessor` と同一ロジック・`src/recorder/agc.ts`）。チェーンは `source → gain(手動) → agcGain(自動) → limiter → dest`。リミッター（`DynamicsCompressor`・-1 dBFS）は **AutoGain の有無に関わらず常時**。
- 保存時の -16 dBFS 正規化は Windows では非対応（MediaRecorder が最終ファイルを直接書くため後段処理を持てない）。実時間 AGC が目標 -20 dBFS へ寄せることで代替する。

### 検証
- AGC 中核（`nextAgcState`/`rmsOf`）を純関数に切り出し、`test/e2e.mjs` で数値検証（クランプ・ゲート・再アーム・上げ遅く下げ速く）。
- ノードグラフ実挙動を Obsidian レンダラ（macOS）で検証（`dev/web-agc-verify.js`・合成正弦波を MediaStream 化）：小音量 +13 dB / AGC オフは素通し +0.2 dB / 過大入力はピーク 0.78＝シーリング以下。
- **Windows 実機での通し確認は未実施**（実機なし）。切り分け用に `dev/win-audio-diag.js`（マイク／ループバックを段階的に測る）を用意。

### W4 の検証手順（Windows 実機）
1. 新 `main.js` を配送 → プラグイン再読み込み
2. 診断 →「Windows 版 whisper を取得」→ `native/whisper/Release/whisper-cli.exe` が展開される
3. 再診断で「whisper.cpp バイナリ [OK]」を確認
4. 既存 `.m4a` を「録音ファイルを文字起こし」、または `停止時に文字起こし`をオンにして録音 → 文字起こしがノートに入るか

lint クリーン・`npm run build` 通過。配送は `\\wsl.localhost\AlmaLinux-10\home\candyma\obsidian-remote-meeting-recorder\` の `main.js`＋`manifest.json` を Vault の `plugins/remote-meeting-recorder\` へコピー。

## 2. フェーズ計画

### Phase W0 — 疎通検証スパイク（最優先・プラグイン改変/ビルド不要）
**目的**: 本実装前に「実際に録れるか」「どの方式か」「どのフォーマットか」を実機で確定する。
- 成果物 `dev/w0-audio-spike.js`（DevTools コンソール貼り付け）で以下を 1 回で判定：
  1. `@electron/remote` からメイン session にアクセスできるか
  2. **方式C**（`setDisplayMediaRequestHandler(audio:'loopback')` → `getDisplayMedia`）でシステム音声トラックが取れるか／ピッカーが出ないか
  3. **方式A**（`desktopCapturer`＋`getUserMedia`）でも取れるか（フォールバック確認）
  4. `getUserMedia`（`echoCancellation:true`）でマイクが取れるか
  5. `isTypeSupported('audio/mp4')` / `'audio/webm;codecs=opus'` の可否
  6. system+mic を Web Audio でミックス → 3 秒録音 → Blob サイズ確認
- **判定 → 以降を確定**。方式C が通れば本命、方式A のみ通れば方式Aで実装、両方ダメなら再設計。

### Phase W1 — レンダラ録音エンジン `src/recorder/webCapture.ts`（新設）
- `WebRecorder` クラス：
  - system（loopback）＋mic を取得 → Web Audio（`MediaStreamAudioDestinationNode`）でミックス
  - `MediaRecorder`（W0 で決めた mime）→ **timeslice で `ondataavailable` を Node `fs` で `out` に逐次追記**
  - `source` = both/system/mic に対応（system=loopback のみ, mic=マイクのみ, both=ミックス）
  - レベルメータは既存 `audio/webAudioTap.ts` の `AnalyserNode` を流用
  - `onstop`/`onerror` を終了・エラー通知に配線
- スリープ抑止は Electron `powerSaveBlocker`（caffeinate 相当の保険・remote 経由）。

### Phase W2 — 状態機械のプラットフォーム分岐
- `types.ts`：`SessionMeta.platform` を `"darwin" | "win32"` に拡張。
- `recorder/start.ts`：`process.platform` で分岐。win32 は sysrec を spawn せず `WebRecorder` を起動し、
  生存 OK（録音開始成功）を確認してから session JSON（`platform:"win32"`）を書く。
- `recorder/stop.ts`：win32 は SIGTERM/status-file を使わず `WebRecorder.stop()` → 最終ファイルで finalize。
- `recorder/watch.ts`：win32 は pid/status ポーリングをせず、elapsed タイマ＋`WebRecorder` イベントを源にする。
- `recorder/start.ts:resolveOutPath`／`util/fsx.ts:intermediatePaths`：拡張子を分岐（`.m4a`/`.webm|.mp4`）。
- `src/main.ts:onunload`：win32 は「録音を殺さない」ではなく**録音を graceful finalize**（レンダラ内なので
  生かし続けられない）。ここは OS 分岐で明示的に挙動を変える。
- `handleTerminal` 以降（埋め込み/デイリーノート/文字起こし）は共通で流用。

### Phase W3 — 診断（doctor）と設定の Windows 対応
- `doctor/diagnostics.ts`：非 darwin の一律 `NG` を撤廃。Windows 分岐を新設：
  - OS バージョン、loopback 可否（remote session に handler を張れるか）、
  - **マイク許可設定「デスクトップアプリにマイクへのアクセスを許可」の案内**、mime 対応、whisper.cpp exe 有無。
  - codesign/lipo/xattr/TCC（macOS 固有）は Windows ではスキップ。
- `util/resolveBin.ts`：win32 は録音に sysrec 不要。whisper-cli.exe の解決を追加。
- `manifest.json`：説明を Windows 対応に更新（`isDesktopOnly` は据え置き）。

### Phase W4 — 文字起こし（Windows・後回し可）
- パイプラインは無改修。必要なのは **Windows 版 whisper-cli.exe＋モデル**（モデル DL は既存のまま流用）。
  doctor からの取得（ダウンロード）導線を Windows 用に用意。録音（W0–W3）が動いてからの follow-up。

## 3. 変更/新設ファイル一覧（見込み）

| ファイル | 種別 | 内容 |
|---|---|---|
| `dev/w0-audio-spike.js` | 新設 | W0 疎通スパイク（使い捨て・後で削除可） |
| `src/recorder/webCapture.ts` | 新設 | レンダラ内録音エンジン `WebRecorder` |
| `src/types.ts` | 変更 | `SessionMeta.platform` を union 化 |
| `src/recorder/start.ts` | 変更 | OS 分岐・拡張子分岐 |
| `src/recorder/stop.ts` | 変更 | win32 停止経路 |
| `src/recorder/watch.ts` | 変更 | win32 監視経路 |
| `src/util/fsx.ts` | 変更 | `intermediatePaths` の拡張子分岐 |
| `src/main.ts` | 変更 | `onunload` の OS 分岐・（必要なら）録音起動の分岐 |
| `src/doctor/diagnostics.ts` | 変更 | Windows 診断分岐 |
| `src/util/resolveBin.ts` | 変更 | win32 の whisper 解決 |
| `manifest.json` | 変更 | 説明更新 |

## 4. 非対応（Windows 経路で意図的に持たないもの）
- **Obsidian 再起動／クラッシュをまたぐ録音復元**（`restore.ts`/`sweep.ts` は darwin 専用）。
  → 緩和はチャンク逐次追記による中断耐性のみ。ユーザーには doctor/README で明示する。
- winrec / ffmpeg / mix サブコマンド（Web Audio で実時間ミックスするため不要）。

## 5. リスクと未知数
- **最大の未知数**: プラグイン（レンダラ）から `@electron/remote` 経由で
  `setDisplayMediaRequestHandler` を張れるか。→ **W0 で最初に潰す**。
- Chromium 側 loopback 実装はバージョン依存（Electron 40 macOS で無音 regression の報告あり）。
  → 実機（ユーザーの Obsidian ビルド）での W0 検証を必須にする。
- webm 埋め込み体験の弱さ → mp4 優先で回避を試みる。
- system/mic の遅延ドリフト・エコー → mic に `echoCancellation:true`、必要なら W1 で調整。

## 6. 開発環境メモ
- 本リポジトリは WSL 側（`/home/candyma/obsidian-remote-meeting-recorder`）。`node_modules` 未インストール
  → ビルドには `npm install` が必要。
- 実機テストは Windows の Obsidian（Vault は G: の Google ドライブ配下）。ビルド成果物 `main.js` の
  Vault への配送方法（同期/コピー/シンボリックリンク）は要確認。W0 はコンソール貼り付けのため配送不要。

## 7. 参考
- 設計書 §2 / §14.6（Windows 対応への示唆）
- ノウハウレポート §8（winrec・不採用側の知見）
- candypi `native/winrec/`（winrec 実装）／`candypi 録音機能 改修要望レポート.md`（実機検証）
- electron/electron#46369（setDisplayMediaRequestHandler / audio:'loopback' / 方式A クラッシュ報告）
