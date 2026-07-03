# Obsidian 録音プラグイン向け 録音ノウハウレポート

candypi 会議録音MCP（recorder コネクタ + macOS 録音バイナリ sysrec）の開発で得た知見を、
**別プロジェクト = Obsidian プラグイン**で再利用できる形に整理したもの。

- 出典コード: `src/connectors/meeting-recorder/`（recipes.ts / tools.ts）、`native/sysrec/sysrec.swift`、`native/winrec/Program.cs`
- 実績: macOS 実機で end-to-end 検証済み（録音→停止→mix→復旧）。レベル処理はテストトーンで RMS -16.0 dBFS / ピーク -1.0 dBFS を数値検証済み。2026-07-02 の実会議録音（39分で中断→原因究明→スリープ対策）まで運用経験あり。

---

## 1. 結論サマリ（Obsidian プラグインに持ち込むもの / 捨てるもの）

**そのまま持ち込めるもの:**

| 資産 | 内容 |
|---|---|
| 録音バイナリ sysrec | ScreenCaptureKit ヘルパー CLI。契約（引数・JSONイベント・停止手段）ごと流用可能 |
| DSP パラメータ一式 | AGC / リミッター / ラウドネス正規化の全定数（§4）。実測検証済み |
| セッション状態機械 | pidfile / status-file / セッションJSON / 孤児sweep / remix 復旧（§5） |
| スリープ対策 | バイナリ内 `beginActivity` + 外側 `caffeinate -w PID` の二重化（§6） |
| UX 原則 | 保存先・音源を毎回確認 / 参加者同意 / AGC 既定 on（§7） |

**捨てるもの（MCP 固有で Obsidian には不要）:**

- レシピ方式（リモートがコマンド文字列を返し手元 Bash が実行する間接層）→ Obsidian プラグインはローカル実行なので `child_process.spawn` で直接バイナリを起動すればよい
- `set -u` 対応の `\${VAR:-}` エスケープ、PowerShell コマンドガード対策、環境変数 (`$RECORDER_BIN` 等) によるパス解決 → すべて「リモートから文字列を送る」制約の産物

---

## 2. アーキテクチャの根本判断: なぜヘルパーバイナリ方式か

**Electron/Chromium（= Obsidian）だけでは macOS のシステム音声が録れない。**

- マイクのみ → `getUserMedia` + `MediaRecorder` で Obsidian 内で完結できる（ヘルパー不要）
- システム音声（会議相手の声）→ macOS では `getDisplayMedia` のシステム音声キャプチャが基本的に使えない（Chromium/Electron のバージョン依存で、Obsidian 側の Electron を選べない以上アテにできない）。**確実なのは ScreenCaptureKit を使う外部ヘルパーバイナリ**
- Windows は WASAPI ループバックで取れる（Electron の desktopCapturer でも可能な場合があるが、winrec のような .NET+NAudio ヘルパーの方が安定・§8）

つまり「システム音声も録る」なら sysrec 相当のヘルパーは必須で、candypi の sysrec（688行の単一 Swift ファイル、外部依存なし、`swiftc` 一発ビルド）はそのまま流用候補になる。

### sysrec の要点（ScreenCaptureKit）

- `SCStreamConfiguration` で `capturesAudio`（システム音声）と `captureMicrophone`（マイク・**macOS 15+**）を同一ストリームで取得
- 映像は不要でも SCK はディスプレイ指定が必須 → `width=100, height=100, minimumFrameInterval=1fps` にして `.screen` フレームは破棄
- `excludesCurrentProcessAudio = true`（自プロセスの音を除外。通知音の混入防止）
- エンコードは `AVAssetWriter`（AAC .m4a、録音時 128kbps / mix 後 192kbps）。**ライタは最初のサンプル到着時に実フォーマット(ASBD)から遅延生成**する — フォーマットを先に決め打ちしない
- `expectsMediaDataInRealTime = true` 必須

### 「both は別録り 2 ファイル → オフライン mix」が正解

システム音声とマイクをリアルタイムに 1 本へミックスせず、`base.sys.m4a` / `base.mic.m4a` に**別録りして停止後に結合**する。理由:

1. 2 ソースのクロック・遅延差をリアルタイムに吸収しなくてよい
2. mix が失敗しても素材が残る（→ §5 の remix 復旧が成立する）
3. トラック別のレベル処理（小声マイク vs 大きいシステム音声）が後段で綺麗にできる
4. 片方だけ録れていた場合も単純 rename で救える

mix は ffmpeg に依存せず AVFoundation で内製（`sysrec mix` サブコマンド）。`AVAudioConverter` で 48kHz/2ch float に揃えてから float のまま加算する（**加算時にクリップさせない** — ピークは後段リミッターに任せる）。

---

## 3. 録音バイナリとの「契約」（プラグイン⇔ヘルパーのインタフェース設計）

candypi で運用実績のある契約。Obsidian プラグインの spawn 相手としてそのまま使える。

```
録音:   sysrec --out <path> [--source both|system|mic] [--mic-device <uid>]
               [--samplerate 48000] [--channels 2] [--agc on|off]
               [--status-file <path>] [--pidfile <path>]
ミックス: sysrec mix --in <a.m4a> --in <b.m4a> --out <out.m4a>
               [--agc on|off] [--normalize on|off]
停止:   SIGINT / SIGTERM / 標準入力に "stop"
終了コード: 0=正常 / 2=権限なし / 3=デバイスなし / 4=ディスク等 / 1=その他
```

- **イベントは stdout と status-file の両方に 1 行 JSON で追記**（`{"event":"started",...}` / `{"event":"stopped","path":...,"durationSec":...,"bytes":...}` / `{"event":"mixed",...,"normGainDb":...}`）。
  - MCP では「プロセスを見張れない」ので status-file が必須だった。Obsidian は spawn した子の stdout を直接読めるが、**status-file は残す価値がある**: プラグインのリロード・Obsidian の再起動をまたいでもセッションを再発見できる（§5 の孤児復旧の要）
- pidfile はバイナリ自身が書く（起動側の推測 PID より確実）
- 停止手段が 3 系統あるのは冗長化。Obsidian からは SIGTERM（`child.kill('SIGTERM')`）が素直

### 権限（TCC）まわりの実務知見

- システム音声 = **「画面収録」権限**（マイク権限とは別）。SCK の `getExcludingDesktopWindows` が権限なしで失敗する → 終了コード 2 + 案内文言で返す
- 権限は**起動元のアプリに付く**（candypi では Claude Code のホストアプリに付いた）。Obsidian から spawn すれば **Obsidian.app に画面収録許可を求めるダイアログ**が出る、と案内する UI を用意しておく
- バイナリは **ad-hoc 署名（`codesign -s -`）しておく**。無署名だと TCC の判定が不安定。ビルドスクリプトに署名を組み込む（`native/sysrec/build.sh` 方式）
- **バイナリを差し替える（再ビルド/更新する）と TCC の再許可を求められることがある**。プラグインの自動更新でヘルパーも更新する設計なら、更新直後の録音失敗→権限再付与の導線を必ず作る

---

## 4. レベル処理 DSP レシピ（実測検証済みの全定数）

candypi で一番工数がかかった部分。**この数値セットはテストトーンで検証済み**（既定設定で gated RMS -16.0 dBFS ちょうど、熱い入力でもピーク -1.0 dBFS、AGC off で完全素通し）。

### 4.1 録音時（ストリーミング AGC + 簡易リミッター）

キャプチャチャンクごとに in-place 適用。`sysrec.swift` の `AGCProcessor` / `StreamingLimiter`（[sysrec.swift:112-172](native/sysrec/sysrec.swift#L112-L172)）。

| 項目 | 値 | 意図 |
|---|---|---|
| 目標 RMS | 0.1 (**-20 dBFS**) | 録音段階はヘッドルーム広め（最終 -16 は mix 段で） |
| 無音ゲート | 0.0018 (**-55 dBFS**) | 無音・環境ノイズを持ち上げない（ゲート未満はゲイン凍結） |
| ゲイン範囲 | 0.125–8.0 (**±18 dB**) | 暴走防止 |
| 追従速度 | 上げ τ=3.0s / 下げ τ=0.4s | slow-attack / fast-release。`gain += (desired-gain)*(1-exp(-dt/τ))` |
| 冒頭ロック | 最初の有音チャンクで即時追従 | 冒頭数秒が小さいまま、を防ぐ |
| ゲイン適用 | チャンク内で線形ランプ | ジッパーノイズ防止（前回ゲイン→今回ゲインへ補間） |
| リミッター | ceiling 0.97・即時アタック・リリース ~100ms | AGC 後段の安全弁。±1.0 でハードクランプ |

### 4.2 mix 時（オフライン 4 段パイプライン）

```
① トラック別 AGC（上と同じ実装を 100ms=4800frame チャンクで流す）
② float のまま加算（クリップさせない）
③ ゲート付き RMS ラウドネス正規化:
     400ms 窓で RMS 測定、RMS>0.003(-50dBFS) の窓だけをエネルギー平均
     → 静的ゲインで目標 0.158(-16 dBFS) へ、±18dB クランプ
④ ルックアヘッドリミッター（常時有効・normalize off でも掛ける）:
     先読み 5ms、必要ゲインのスライディング最小値（単調キュー）
     アタック 1.5ms / リリース 50ms、ceiling 0.891(-1 dBFS)
     最終 ±0.985 ハードクランプ
```

**ハマりどころ 2 点（両方とも実際に踏んだ）:**

1. **リミッターの初期ゲインは先頭ルックアヘッド窓の最小必要ゲインでプリシードする**。gain=1.0 スタートだと冒頭から熱い入力のときアタックが間に合わずピークが漏れる（-0.2 dBFS まで漏れた実測あり。プリシード後は正確に -1.0 dBFS）
2. **③のラウドネス測定は必ず無音ゲート付きで**。会議録音は無音が長く、ゲートなし RMS だと過剰にゲインを持ち上げる

### 4.3 ffmpeg 等価チェーン（ヘルパーを作らない経路・Windows 用に検証設計済み)

自前 DSP を書かずに ffmpeg へ寄せる場合の等価フィルタ（winrec 経路で採用）:

```
both:   [0:a]dynaudnorm[a0];[1:a]dynaudnorm[a1];
        [a0][a1]amix=inputs=2:normalize=0,
        loudnorm=I=-16:TP=-1.5:LRA=11,
        alimiter=limit=0.891:attack=5:release=50:level=false
単一:   -af "dynaudnorm,loudnorm=...,alimiter=..."
```

- `amix` は必ず `normalize=0`（既定の 1/n 減衰を殺す）
- `alimiter` は `level=false` 必須（既定 true は勝手にメイクアップゲインする）
- dynaudnorm=AGC 相当、loudnorm=正規化相当、alimiter=リミッター相当、と 4.1/4.2 に 1:1 対応

### 4.4 CoreMedia の重大な罠（Swift でキャプチャ中に DSP するなら必読）

`CMSampleBuffer` の PCM を書き換える正しい手順（[sysrec.swift:255-306](native/sysrec/sysrec.swift#L255-L306)）:

1. **`sb.withAudioBufferList(blockBufferMemoryAllocator:)`（Swift オーバーレイ）を使うこと**。手動で `CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer` を呼ぶと、バッファサイズを多めに渡しても **-12737 (kCMSampleBufferError_ArrayTooSmall)** で失敗する（プローブで再現確認済み）
2. 取り出した blockBuffer は**元バッファと同一メモリとは限らない**。in-place で書き換えても元の CMSampleBuffer には反映されない前提で、**加工後は `CMSampleBufferCreate` で新しいサンプルバッファに包み直して**ライタへ渡す
3. interleaved（ABL 1 本・stride=ch数）と planar（ABL 複数・stride=1）の両対応が必要。SCK はソースによって両方来る
4. 失敗時は **nil を返して元バッファを素通し**（録音を止めない。DSP は失敗しても録音自体は守る）

### 4.5 Obsidian 内蔵（Web Audio）でやる場合の対応表

マイクのみ録音を Obsidian 内で完結させるなら:

- 簡易 AGC+リミッター → `DynamicsCompressorNode`（threshold -20dB / ratio 高め / knee）で近似可
- 本格的にやるなら `AudioWorkletProcessor` に §4.1 のアルゴリズムをそのまま移植（float 配列処理なので Swift 版とほぼ同型になる）
- ラウドネス正規化は録音後に AudioBuffer 全体へ §4.2 ③④ を適用してから encode

---

## 5. セッション管理と堅牢性（「録音データを絶対に失わない」ための設計）

### 状態ディレクトリ構成

```
~/.meeting-recorder/
  sessions/<sessionId>.json    # {id,pid,source,agc,out,bin,startedAt,label}
  sessions/<sessionId>.pid     # バイナリ自身が書く
  sessions/<sessionId>.status  # バイナリのイベント追記先
  sessions/<sessionId>.log     # バイナリの stderr
  logs/<sessionId>.log         # 終了後の退避先（30日で自動掃除）
```

### 実際に効いた設計ルール

1. **起動検証してからセッション JSON を書く**: spawn → pidfile 出現待ち（0.1s × 最大30回）→ `kill -0` で生存確認 → OK のときだけ JSON を書く。pid=0 や即死セッションの「壊れた JSON」を残さない
2. **孤児セッションの自動 sweep を start 冒頭に置く**: PID が死んでいる or JSON が壊れているセッションを掃除。**ただし中間ファイル（*.sys.m4a/*.mic.m4a）が残っているものは温存**（= 再結合待ち。消すと録音データ喪失）
3. **mix 失敗時は絶対に中間ファイルを消さない**: セッション JSON も温存し、`stop-warning` イベントで「remix で復旧可能」と返す。専用の remix 経路（sessionId または outPath から `base.sys/.mic` を探して再結合）を最初から用意する。**これは保険ではなく必須機能**（実運用で mix 失敗→remix 復旧を実際に使った）
4. **終端イベントは機械可読 JSON の最終行に固定**: `stopped / stop-warning / stop-error / remixed / remix-error`。呼び出し側（プラグインの UI 層）はこの行だけ解釈すれば分岐が書ける
5. **ログは削除せず退避**: 2026-07-02 の録音中断の原因究明ができたのは stderr ログが残っていたから…ではなく、**当時は stop 成功時にログを消していて調査に難儀した**のが教訓。成功時も `logs/` へ mv、30日ローテ（`find -mtime +30 -delete`）
6. **ファイル名衝突は自動連番**: `name.m4a` が存在したら `name-2.m4a`, `name-3.m4a`…（上書き事故防止）
7. **片方だけ録れていたら rename で救う**: both 指定で sys だけ/mic だけ存在 → mix せず `mv` で最終ファイル化

Obsidian 版では sessions/ を `.obsidian/plugins/<id>/data` 配下か plugin data として持てばよいが、**「プラグインのプロセス（レンダラ）が死んでも録音バイナリは生き続ける」**ので、状態はメモリでなくファイルに置く原則は変わらない。Obsidian 再起動後に status-file とpidfile から進行中セッションを再発見して「録音継続中」UI を復元する、まで作ると堅い。

---

## 6. スリープ対策（実際に録音を 39 分で失った事故からの教訓）

**事故**: 2026-07-02、会議録音がアイドルスリープで 39 分時点で中断。マイク使用中でも coreaudiod のアサーション任せではスリープを防げなかった。

**対策（二重化・両方入れて無害）:**

1. **本筋 = バイナリ自身が電源アサーションを持つ**:
   ```swift
   powerActivity = ProcessInfo.processInfo.beginActivity(
       options: .idleSystemSleepDisabled, reason: "recording")
   // 戻り値をグローバルに保持（解放されると抑止が外れる）。プロセス終了で自動解除
   ```
2. **外側からの保険 = `caffeinate -i -m -w <録音PID>`**: `-w` で録音プロセス終了と同時に caffeinate も自動終了（消し忘れゼロ）。`-d`（ディスプレイ）は付けない — 画面は寝てよい
3. 長時間録音の **mix 処理中も** アイドルスリープし得る → mix コマンドも `caffeinate -i` でラップ

**Obsidian 固有の注意**: Electron の `powerSaveBlocker` はメインプロセス API で、プラグイン（レンダラ）からは直接触れない。`navigator.wakeLock` は画面ロック用でシステムスリープは防げない。→ **ヘルパーバイナリ側で beginActivity を持つ**（上記 1）のが Obsidian でもそのまま正解になる。マイクのみ・Web Audio 録音の場合はヘルパーがいないので、`caffeinate -i -w <ObsidianのPID>` を spawn する等の工夫が要る。

**限界**: どの方式でも **MacBook の蓋閉じスリープは防げない**（クラムシェル動作は外部電源+外部ディスプレイが条件）。これは防ぐのではなく **UI に明記して注意喚起**する（candypi ではツール説明と開始時 note に記載）。

検証方法: 録音中に `pmset -g assertions` で `PreventUserIdleSystemSleep ... asserting on behalf of Process ID <pid>` を確認。

---

## 7. UX の教訓

1. **保存先と録音ソース（mic/system/both）は録音のたびに必ずユーザーに確認する**。既定値への暗黙フォールバックで「意図しない場所に保存」「マイクだけのつもりが both」が起きる。candypi ではこの確認要求を**ツール定義（description/param describe）に埋め込んで全クライアントに効かせた**。Obsidian 版なら録音開始モーダルで毎回明示選択させる（前回値をプリセットにするのは可、無確認スキップは不可）
2. **参加者への録音告知・同意**を開始フローに組み込む（candypi ではツール説明+note で毎回リマインド）
3. **AGC は既定 on、「原音のまま」をオプトアウトで用意**（`agc: false`）。設定は開始時に決めて**セッションに記録し、停止/再結合まで引き継ぐ**（途中でプラグイン設定が変わっても録音単位で一貫）
4. ファイル名既定は**ローカル時刻** `YYYY-MM-DD-HHMM.m4a`（Obsidian ならデイリーノート連携で `[[2026-07-03]]` に埋め込む導線が作れる）
5. **セットアップ診断（doctor）を最初に作る**: バイナリの有無・実行可否・署名・状態ディレクトリ書き込み可否・権限案内を [OK]/[NG]+直し方付きで一覧する機能。「動かない」問い合わせの一次切り分けが劇的に楽になる

---

## 8. Windows 対応ノウハウ（将来対応するなら）

winrec（.NET 8 + NAudio、`native/winrec/`）で設計済み・**実機未検証**の知見:

- システム音声 = **WASAPI ループバック（権限不要）**、マイク = OS 設定「デスクトップアプリにマイクへのアクセスを許可」が必要。未署名 exe は SmartScreen 警告
- 録音は WAV 中間 → 停止時に ffmpeg で .m4a 化（§4.3 のチェーン）。**ffmpeg が必須依存**になる（mac と非対称）
- **graceful 停止は「stop ファイル（センチネル）」方式**: 停止側がファイルを作る → winrec が検知して finalize。taskkill だと WAV ヘッダ未確定で破損する
- 保険として **録音中も 1 秒ごとに WAV ヘッダを更新**しておく → 強制終了されても直近までは再生可能
- ffmpeg 導入は「既存検出 → winget → スタティックビルド DL」の 3 段フォールバックで自動化できる（`installRecipeWin` 実装済み）

---

## 9. Obsidian プラグイン固有の課題（candypi には無かった論点）

1. **`isDesktopOnly: true` 必須**。`child_process` 等の Node API はデスクトップ版レンダラで `require` 可能
2. **バイナリの配布問題**: コミュニティプラグインの配布物は実質 `main.js` / `manifest.json` / `styles.css` のみ。sysrec 相当のバイナリは
   - (a) 初回起動時に GitHub Release からダウンロード、または
   - (b) ユーザーに `swiftc` ビルドさせる（sysrec は単一ファイル・依存なしなので現実的）
   - ダウンロード配布なら **quarantine 属性と署名**に注意（実行拒否時は `xattr -d com.apple.quarantine` + ad-hoc `codesign`。doctor 機能に組み込む）。アーキテクチャは universal binary か arm64/x86_64 の出し分け
3. **保存先**: Vault 内に保存すれば添付として `![[meeting.m4a]]` 埋め込み再生が可能（m4a は Obsidian 対応形式）。Vault 外保存の選択肢も残す（同期対象にしたくない大容量ファイル対策）。Vault 内パスは `normalizePath` + adapter 経由で
4. **プラグインリロード耐性**: 録音バイナリは Obsidian と独立に生きるので、`onunload` で録音を殺さないこと。リロード後に §5 の状態ファイルから進行中セッションを復元する
5. **文字起こし連携**が Obsidian では本命ユースケースになりやすい。stopped イベントの `path` を Whisper 等へ渡してノート化するフックを最初から設計しておくと拡張が楽

---

## 10. 検証手法（そのまま再利用できるテスト戦略)

1. **テストトーンによる DSP 数値検証**: 既知レベルの WAV（正弦波・レベル段差付き）を生成 → パイプラインに通す → RIFF を自前パースして RMS/ピークを assert（Python の `wave` モジュールは WAVE_FORMAT_EXTENSIBLE を読めないので**手書き RIFF パーサが必要**だった）。「AGC on で -16.0 dBFS / off で素通し / 熱い入力でピーク -1.0 dBFS」を数値で確認
2. **ニセ録音バイナリで E2E**: pidfile/status-file 契約だけ再現する 20 行のシェルスクリプト（TERM を trap して stopped イベントを書く）を `RECORDER_BIN` に差して、開始→停止→mix失敗→remix復旧→孤児sweep の全経路を実バイナリなしで回す。CI にも載せられる
3. **スリープ抑止は `pmset -g assertions`** で録音 PID のアサーションを目視確認
4. CoreMedia のような「失敗すると黙って素通しになる」経路は、**単体プローブ**（最小 Swift ファイルで API 挙動だけ検証）を先に書く — 本体に組み込んでからだと無音の劣化に気づけない

---

## 付録: 参照ファイル

| ファイル | 内容 |
|---|---|
| [native/sysrec/sysrec.swift](native/sysrec/sysrec.swift) | 録音バイナリ本体（SCK キャプチャ / DSP / mix / スリープ抑止） |
| [native/sysrec/build.sh](native/sysrec/build.sh) | swiftc ビルド + ad-hoc 署名 |
| [src/connectors/meeting-recorder/recipes.ts](src/connectors/meeting-recorder/recipes.ts) | セッション管理シェルスクリプトの実装（sweep / 復旧 / ログ退避の具体形） |
| [src/connectors/meeting-recorder/tools.ts](src/connectors/meeting-recorder/tools.ts) | UX 契約の文言（毎回確認・同意・イベント解釈） |
| [native/winrec/Program.cs](native/winrec/Program.cs) | Windows 版（NAudio / stop-file / ヘッダ逐次更新） |
| 会議録音MCP設計書.md / 改修提案書.md / candypi 録音 caffeinate 改修提案.md | 設計経緯（git 履歴参照） |

*作成: 2026-07-03（candypi main `302aefb` 時点の実装に基づく）*
