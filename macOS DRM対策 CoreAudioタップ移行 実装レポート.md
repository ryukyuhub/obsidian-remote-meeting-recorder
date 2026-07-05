# macOS DRM 対策：システム音声取得を Core Audio プロセスタップへ移行する実装レポート

> 作成日: 2026-07-05 / 対象: `remote-meeting-recorder`（macOS 側 `native/sysrec/sysrec.swift`）
> 目的: 録音中に DRM 保護動画（Netflix 等）が黒画面になる問題を、録音エンジンの取得方式変更で解消する。
> 位置づけ: **macOS 実機で開発再開するときの単一の入口ドキュメント**。設計判断は `リモート会議録音プラグイン 設計書.md` §2 の更新を伴う（ScreenCaptureKit 前提の見直し）。

---

## 0. TL;DR（結論だけ）

- **問題**: 録音中に Netflix の映像が黒くなる（macOS のみ・Netflix 等 DRM 動画のみ）。
- **原因**: sysrec がシステム音声を **ScreenCaptureKit（画面キャプチャ API）** で取得しており、OS が「画面録画中」状態になる。DRM プレイヤーはこれを検知して保護映像を黒く落とす（正常な保護動作）。
- **対策**: システム音声の取得を **Core Audio プロセスタップ（macOS 14.4+ / `AudioHardwareCreateProcessTap` + `CATapDescription`）** に置き換える。画面キャプチャをしなくなるので DRM 映像は黒くならない。
- **要注意スコープ**: マイク取得も現状 SCK（`captureMicrophone`）。**マイク単独の SCStream でも「画面録画中」になり黒くなるなら、マイクも SCK から外す必要がある**（→ SCK 完全撤去）。ここが最大の未確定。**Spike で最初に確定させる（検証項目 ④）**。
- **進め方**: いきなり全書き換えせず、**最小の検証（spike）→ スコープ確定 → 段階実装（SCK はフォールバックとして一時併存）**。

---

## 1. 背景と問題の再現条件

| 条件 | 黒くなる? | 理由 |
|---|---|---|
| macOS / 録音中 / Netflix 再生 | **なる** | DRM(FairPlay) が「画面録画中」を検知して保護映像を黒画面化 |
| macOS / 録音中 / YouTube 再生 | ならない | YouTube は DRM 非保護 |
| macOS / 録音停止中 / Netflix | ならない | 画面録画状態でない |
| Windows / 録音中 / Netflix | ならない | 音声取得が WASAPI ループバック（画面キャプチャを起こさない） |

- 自分の画面上でも黒くなるのは、DRM プレイヤーが録画検知時に復号フレームを合成器へ出さないため。
- **音声自体は録れている**（DRM が消すのは映像のみ）。困りごとは「会議録音中にたまたま保護動画を開くと画面が黒くなる」という体験面。

---

## 2. 現状アーキテクチャ（コード地図）

システム音声もマイクも **単一の `SCStream`** から取得している。

- 取得設定・開始: [`native/sysrec/sysrec.swift` `configureAndStart()`](native/sysrec/sysrec.swift#L408-L432)
  - `SCContentFilter(display:excludingWindows:)` … **ディスプレイに紐づくフィルタ＝画面キャプチャ**
  - `cfg.capturesAudio`（system）/ `cfg.captureMicrophone`（mic）/ `cfg.sampleRate` / `cfg.channelCount`
  - `cfg.width = 100; cfg.height = 100` … 映像は最小化して捨てるが **OS 的には画面録画中になる**（これが DRM トリガ）
  - `cfg.excludesCurrentProcessAudio = true` … 自アプリ音の混入除外
  - `stream.startCapture { ... }`
- サンプル受信: [`stream(_:didOutputSampleBuffer:of:)`](native/sysrec/sysrec.swift#L449-L458)
  - `.audio → sysBox?.append(sampleBuffer)` / `.microphone → micBox?.append(sampleBuffer)` / `.screen` は破棄
- 書き出し: [`WriterBox`](native/sysrec/sysrec.swift#L227) … `CMSampleBuffer` を受けて AGC/リミッター適用後に AAC(.m4a) へ逐次書き込み
  - `both` は `.sys.m4a` / `.mic.m4a` を別々に録り、あとで mix
- ミックス: [`runMix()`](native/sysrec/sysrec.swift#L490) … 2 ファイルを 48kHz でミックスして最終 .m4a を書く（**この部分は今回変更不要**）
- AGC / リミッター: `AGCProcessor` / `StreamingLimiter` … **Float32 ポインタ列を処理する純粋ロジック。再利用可能**
- 権限まわり:
  - entitlements: [`native/sysrec/sysrec.entitlements`](native/sysrec/sysrec.entitlements) … 現状 `com.apple.security.device.audio-input` のみ
  - TCC 案内: [`src/doctor/diagnostics.ts` `TCC_GUIDE`](src/doctor/diagnostics.ts#L421-L423) … 「画面収録」を要求（`--source mic` でも SCK を開くため画面収録権限が要る旨も明記）
  - 権限プリフライト: `tccCheck()`（`sysrec check-permission`）

### CLI 契約（TS ↔ sysrec）※移行後も維持したい
- 録音: `sysrec --out <path> --source both|system|mic [--mic-device <uid>] --samplerate <n> --channels <n> --agc on|off --status-file <p> --pidfile <p>`
- ミックス: `sysrec mix --in <a> --in <b> --out <out> [--agc][--normalize][--channels][--samplerate]`
- 状態は **ファイルシステムが真実の源**（`~/.meeting-recorder/`）。sysrec はレンダラより長生きする前提。**この契約と堅牢性思想は変えない**。

---

## 3. 目標 / 非目標

**目標**
- 録音中に DRM 保護動画が黒くならない（＝システム音声取得で画面キャプチャを起こさない）。
- 既存の CLI 契約・状態機械・堅牢性（録音を失わない・孤児 sweep・stop-warning→remix 復旧）を維持。
- AGC / リミッター / mix / 文字起こし連携はそのまま流用。

**非目標**
- DRM 保護音声を録ること（保護音声はタップからも除外され得る。会議用途では不要）。
- Windows 側の変更（別経路・無関係）。
- mix ロジックや出力フォーマットの変更。

---

## 4. 技術方針：Core Audio プロセスタップ

macOS 14.4+ の CoreAudio に、画面キャプチャを起こさずシステム音声を取得する API がある（Audio Hijack 等が使う方式）。本プロジェクトは **macOS 15+ 対象なので OS 下限は後退しない**。

### 4.1 取得の基本パターン（アグリゲートデバイス + IOProc）

1. **タップ記述子を作る**: `CATapDescription`
   - 自アプリ除外つき全体タップ: `init(stereoGlobalTapButExcludeProcesses: [ownAudioObjectPID])`（`excludesCurrentProcessAudio = true` の置き換え）
   - `isPrivate = true`（システム全体に露出させない）
   - `muteBehavior = .unmuted`（**実出力はミュートしない＝ユーザは音を聞ける**。ここ重要）
2. **タップ生成**: `AudioHardwareCreateProcessTap(tapDescription, &tapID)` → `AudioObjectID`
3. **フォーマット取得**: `kAudioTapPropertyFormat` を `AudioObjectGetPropertyData` で読む → `AudioStreamBasicDescription`
4. **アグリゲートデバイス作成**: `AudioHardwareCreateAggregateDevice(description, &aggID)`
   - `kAudioAggregateDeviceIsPrivateKey = true`
   - `kAudioAggregateDeviceTapListKey = [ { kAudioSubTapUIDKey: <tapUID> } ]`
   - メイン出力デバイス UID を含める
5. **IOProc 登録**: `AudioDeviceCreateIOProcIDWithBlock(...)` … ブロック内で `AudioBufferList`（タップ音声）を受ける
6. **開始**: `AudioDeviceStart(aggID, ioProcID)`
7. **停止（順序厳守）**: `AudioDeviceStop` → `AudioDeviceDestroyIOProcID` → `AudioHardwareDestroyAggregateDevice` → `AudioHardwareDestroyProcessTap`

### 4.2 既存書き出しパイプラインへの接続

IOProc は `AudioBufferList`（Float32 想定）で届く。現 `WriterBox.append` は `CMSampleBuffer` を受ける。2 案:

- **案 (b)（推奨・変更最小）**: IOProc 内で `AudioBufferList` + フォーマット記述 + タイミングから `CMSampleBuffer` を組み立て、**既存 `WriterBox.append` にそのまま渡す**。実績ある書き出し/AGC/リミッター経路を触らない。
  - `CMAudioFormatDescriptionCreate` でフォーマット記述、`CMSampleBufferCreate`（または `CMAudioSampleBufferCreateWithPacketDescriptions`）でラップ。PTS はホスト時刻（`mach_absolute_time` → `CMClockGetHostTimeClock`）から生成。
- **案 (a)（クリーンだが大きい）**: `WriterBox` を `AVAudioFile`(AAC) ベースに作り替え、Float32 バッファを直接書く。CMSampleBuffer 変換が不要になるが、実績ある経路の作り替えでリスク大。

→ **まず (b) で通し、余力があれば (a) を検討。**

### 4.3 マイク取得（スコープ次第）

- **もし SCK を完全撤去する場合**: マイクは `AVAudioEngine.inputNode.installTap(onBus:)` で Float32 `AVAudioPCMBuffer` を取得 → 既存 AGC/リミッター/WriterBox に接続。`--mic-device` 指定は `AVAudioEngine` の入力デバイス設定（`AVAudioUnit`/`kAudioOutputUnitProperty_CurrentDevice`）で対応。
- **もしマイク SCK 継続でも黒くならないなら**: マイクは現状維持（変更最小）。→ **検証項目 ④ で判定**。

---

## 5. スコープの分岐点（最重要・未確定）

```
システム音声を Core Audio タップに移す
        │
        ├─ Q: マイク単独の SCStream(captureMicrophone) でも「画面録画中」になり Netflix が黒くなる?
        │
        ├─ YES → マイクも SCK から外す（AVAudioEngine へ）。SCK 完全撤去。＝大きめの書き換え
        │
        └─ NO  → マイクは SCK 継続。システム音声のみタップ化。＝小さめの書き換え
```

この分岐で工数が倍近く変わる。**Spike の検証項目 ④ で最優先に確定させる。**

---

## 6. Spike（検証）計画 ― 本実装の前に必ず実施

Windows の [`dev/w0-audio-spike.js`](dev/w0-audio-spike.js) と同じ思想。**最小の Swift 試作**を作り、本番コードに触れずに不確実点を潰す。試作は `native/sysrec/spike/` 等に隔離。

### 検証項目と成功条件

| # | 検証内容 | 手順 | 成功条件 |
|---|---|---|---|
| ① | タップ稼働中に **Netflix が黒くならない** | 試作でシステム音声タップを開始 → ブラウザで Netflix 再生 | 映像が黒くならず再生継続（**本命**） |
| ② | 通常音声が録れる / 保護音声の扱い | YouTube・会議アプリ・Netflix をそれぞれタップ録音 | 非保護は正常録音。保護音声は無音でも可（想定内） |
| ③ | **TCC 権限**の実体 | 未許可状態でタップ作成 → プロンプト/エラーを観察 | 要求される権限種別（画面収録でない）と初回プロンプト挙動を把握 |
| ④ | **マイク単独 SCStream でも黒くなるか** | `captureMicrophone` のみの SCStream を開始 → Netflix 再生 | 黒くなる/ならないを確定（＝スコープ確定） |
| ⑤ | 出力デバイス切替耐性 | 録音中に出力先を内蔵↔BT↔AirPlay 切替 | 無音化/クラッシュしない、または再構築で復帰する挙動を把握 |
| ⑥ | 自プロセス除外 | Obsidian 側で音を鳴らしながらタップ録音 | 自アプリ音が混入しない（`excludeProcesses` が効く） |
| ⑦ | フォーマット/サンプルレート | タップの ASBD を確認 | 既存 WriterBox / `--samplerate` と整合できるフォーマットで取れる |

### Spike の最小コード骨子（擬似）
```swift
// 1) 記述子（自プロセス除外・非ミュート）
let desc = CATapDescription(stereoGlobalTapButExcludeProcesses: [ /* own audio PID */ ])
desc.isPrivate = true
desc.muteBehavior = .unmuted
// 2) タップ
var tapID = AudioObjectID(kAudioObjectUnknown)
AudioHardwareCreateProcessTap(desc, &tapID)
// 3) フォーマット（kAudioTapPropertyFormat）
// 4) アグリゲートデバイス（kAudioAggregateDeviceTapListKey に sub-tap UID）
// 5) AudioDeviceCreateIOProcIDWithBlock { inNow, inData, ... in  /* AudioBufferList → ファイルへ */ }
// 6) AudioDeviceStart
// … 一定秒後 …
// 7) Stop/Destroy を順序厳守で
```

---

## 7. 本実装設計（Spice 後）

### 7.1 sysrec.swift の改修点
- **新規**: `TapCapturer`（Core Audio タップ + アグリゲート + IOProc を管理）。現 `Capturer`（SCStreamDelegate）と差し替え可能なインターフェイスにする。
- **差し替え点**: `configureAndStart()` を、SCK ではなくタップ開始に。`didOutputSampleBuffer` 相当は IOProc ブロックへ。
- **流用**: `WriterBox` / `AGCProcessor` / `StreamingLimiter` / `runMix()` / status-file/pidfile/JSON プロトコル。
- **マイク**: スコープ次第（§5）。撤去時は `MicCapturer`（AVAudioEngine）を新設。
- **停止/クリーンアップ**: タップ/アグリゲート/IOProc の破棄を `finishAndExit` に組み込み、順序を厳守（リーク・デバイス残留を防ぐ）。
- **フォールバック（推奨）**: `--engine sck|tap`（既定は段階的に）。当面 SCK 経路を残し、問題時に切り戻せるように。

### 7.2 CLI 契約
- 既存フラグは維持。追加は `--engine`（任意）程度。TS 側の呼び出し（`src/recorder/start.ts` の `buildArgv`）はほぼ不変。

### 7.3 権限 / entitlements（**要検証・§10**）
- entitlements: 画面収録前提が外れる。タップに必要な権限/エンタイトルメントを spike ③ の結果で確定（`audio-input` に加えて必要なものがあるか）。App Sandbox 下でタップが動くかも確認。
- doctor: [`TCC_GUIDE`](src/doctor/diagnostics.ts#L421-L423) を「画面収録」→ タップ用権限の案内へ更新。`tccCheck` / `sysrec check-permission` をタップ権限の実検査に変更。`--source mic でも画面収録が要る` の記述は撤廃。

### 7.4 TS / Electron 側
- 原則不変（CLI 契約と状態機械を維持するため）。変更は doctor の文言・権限チェックが中心。

---

## 8. 同期・タイムベースの注意

- SCK は system+mic を共通タイムベースで供給していた。**タップ（system）と AVAudioEngine（mic）は独立クロック**になり、長時間録音で **ドリフト**が出得る。
- 緩和: 両 WriterBox に **共通の壁時計開始時刻**を持たせ、PTS をホスト時刻基準で刻む。mix は既存どおり別ファイルを突き合わせる。
- **長時間録音（60分級）でのズレをテスト必須**（§11）。

---

## 9. デメリット・リスクと緩和策（合意済みの整理）

| リスク | 内容 | 緩和策 |
|---|---|---|
| 中核の回帰リスク | 「録音を失わない」心臓部の作り替え | フォールバック `--engine sck` 併存 / 段階導入 / WriterBox は流用（案 b） |
| スコープ拡大 | マイクも移すと SCK 完全撤去に | Spike ④ で早期確定してから着手 |
| クロックドリフト | system/mic 独立クロック | 共通壁時計 + 長時間テスト |
| 権限移行 | 既存ユーザが別権限を付け直し | doctor で明確に再案内 / 初回プロンプト設計 |
| 経路エッジケース | 出力切替/BT/AirPlay/集約デバイス | Spike ⑤ + テストマトリクスで網羅 |
| 検証環境 | Swift は Mac でしかビルド/検証不可 | 本ドキュメント + spike で反復を短縮 |
| 保護音声の欠落 | DRM 音声はタップ除外され得る | 会議用途では非目標。仕様として明記 |

---

## 10. 未解決の確認事項（Spike で潰す）

- [ ] タップに必要な **TCC 権限の種別**（画面収録でない何か）と、初回プロンプトの文言・タイミング。
- [ ] **App Sandbox** 下でタップ/アグリゲートデバイス作成が許可されるか。必要なエンタイトルメント。
- [ ] **保護音声（Netflix 等）がタップで無音になるか**（②）。
- [ ] **マイク単独 SCStream が DRM を誘発するか**（④＝スコープ確定）。
- [ ] 出力デバイス切替時にタップ/アグリゲートの**再構築が要るか**（⑤）。
- [ ] タップの **ASBD**（サンプルレート/チャンネル/インターリーブ）と WriterBox 整合。

---

## 11. テストマトリクス（本実装後）

- ソース: `system` / `mic` / `both`
- 音声: 会議アプリ（Zoom/Meet/Teams）/ YouTube / **Netflix（黒くならないこと）** / 無音
- 出力先: 内蔵スピーカ / BT ヘッドホン / AirPlay / 外部 DAC / 録音中に切替
- サンプルレート: 48000 / 24000 / 16000（ビットレート連動も併せて確認）
- 長さ: 短（1分）/ 中（10分）/ 長（60分・ドリフト確認）
- 異常系: 録音中クラッシュ → 孤児 sweep で中間ファイル温存 / stop 失敗 → remix 復旧 / 片系のみ → rename 救済
- 権限: 未許可 → プロンプト → 許可後に録音成功
- 文字起こし: 生成 m4a が `decodeToPcm16k`（[pcm.ts](src/transcribe/pcm.ts)）で問題なくデコードできる

---

## 12. 参考資料（Mac で最初に見る）

- Apple Developer: **CoreAudio `CATapDescription`** / `AudioHardwareCreateProcessTap` / `AudioHardwareCreateAggregateDevice`（`AudioHardware.h` / `CATapDescription` ヘッダ）
- Apple サンプル: **「Capturing system audio with Core Audio taps」**（アグリゲート + IOProc の公式手本）
- 参考実装（OSS）: **AudioCap**（Guilherme Rambo, `github.com/insidegui/AudioCap`）― タップ + アグリゲートの実例
- WWDC24 セッション（システム音声キャプチャ / Core Audio taps 紹介）
- 既存プロジェクト内: `リモート会議録音プラグイン 設計書.md` §2（ScreenCaptureKit 採用の経緯 ― 本移行で更新対象）、`Obsidian録音プラグイン向け 録音ノウハウレポート.md`

---

## 13. 作業チェックリスト（順序）

1. [ ] `native/sysrec/spike/` に最小タップ試作を作成
2. [ ] Spike ①〜⑦ を実機で確認し、**§10 の未解決事項を埋める**
3. [ ] **スコープ確定**（マイクも移すか / SCK 撤去か併存か）
4. [ ] `TapCapturer` 実装（案 b: CMSampleBuffer 化して既存 WriterBox に接続）
5. [ ] （必要なら）`MicCapturer`（AVAudioEngine）実装
6. [ ] 停止/破棄の順序・リーク対策・共通タイムベース
7. [ ] `--engine sck|tap` フォールバック導入
8. [ ] entitlements 更新、`build.sh` の署名確認
9. [ ] doctor（TCC 文言・`check-permission`）更新
10. [ ] テストマトリクス実施（特に Netflix 非黒・長時間ドリフト・異常系）
11. [ ] `設計書 §2` を「タップ方式」に更新、本レポートに結果を追記
12. [ ] `npm run build-sysrec` で本番バイナリ生成 → 配布

---

## 付記：現状の暫定運用（移行までの間）

- 本移行が完了するまでは「録音中は DRM 保護動画（Netflix 等）が黒くなる（音声は録れている）」を**既知の仕様**として UI/README に注意書きする案（対策 B）も併用可能。
