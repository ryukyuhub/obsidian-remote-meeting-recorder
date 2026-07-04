import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import type RemoteMeetingRecorderPlugin from "./main";
import type { RecorderSource } from "./types";
import { binCandidates } from "./util/resolveBin";
import { DoctorModal } from "./ui/DoctorModal";

/** プラグイン設定（設計書 §9.3）。録音ごとの値はビューが持ち、ここは初期プリセット。 */
export interface RMRSettings {
  /** sysrec バイナリの絶対パス（空なら自動検出） */
  binPath: string;
  /** 既定保存先（Vault 内なら Vault 相対、外なら絶対） */
  defaultSaveDir: string;
  saveInVault: boolean;
  /** 状態ディレクトリ（空なら $HOME/.meeting-recorder） */
  stateDir: string;
  sampleRate: number;
  channels: number;
  defaultAgc: boolean;
  defaultSource: RecorderSource;
  monitor: boolean;
  inputDeviceUid: string;
  insertEmbedOnStop: boolean;
  linkToDailyNote: boolean;
  enableControlWindow: boolean;
  // 文字起こし（Phase 6・設計書 §15）
  transcribeOnStop: boolean;
  /** whisper.cpp バイナリの絶対パス（空なら自動検出） */
  whisperCppBinPath: string;
  /** whisper.cpp モデル（ggml .bin の絶対パス、または models/ 下の名前） */
  whisperCppModel: string;
  transcribeLanguage: string;
}

export const DEFAULT_SETTINGS: RMRSettings = {
  binPath: "",
  defaultSaveDir: "Recordings",
  saveInVault: true,
  stateDir: "",
  sampleRate: 48000,
  channels: 1,
  defaultAgc: true,
  defaultSource: "both",
  monitor: false,
  inputDeviceUid: "",
  insertEmbedOnStop: true,
  linkToDailyNote: false,
  enableControlWindow: false,
  transcribeOnStop: false,
  whisperCppBinPath: "",
  whisperCppModel: "",
  transcribeLanguage: "ja",
};

export class RMRSettingTab extends PluginSettingTab {
  plugin: RemoteMeetingRecorderPlugin;

  constructor(app: App, plugin: RemoteMeetingRecorderPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    const s = this.plugin.settings;
    containerEl.empty();

    // --- バージョン表示（BRAT 配布で現在版が分かるように） ---
    new Setting(containerEl)
      .setName(this.plugin.manifest.name)
      .setDesc(`バージョン ${this.plugin.manifest.version}`)
      .setHeading();

    // --- バイナリ ---
    this.heading("録音エンジン（sysrec）");

    const binSetting = new Setting(containerEl)
      .setName("バイナリパス")
      .setDesc(
        "空欄でOK。録音・診断のたびに native/sysrec/sysrec → bin/sysrec → PATH の順で自動検出します。" +
          "「検出」は今どこで見つかるかを確認するだけのボタンです（押さなくても録音できます／設定は保存されません）。"
      );
    binSetting.addText((text) =>
      text
        .setPlaceholder("（自動検出）")
        .setValue(s.binPath)
        .onChange(async (value) => {
          s.binPath = value.trim();
          await this.plugin.saveSettings();
        })
    );
    binSetting.addButton((btn) =>
      btn
        .setButtonText("検出")
        .setTooltip("今どこで見つかるかを確認します（設定は変更しません）")
        .onClick(() => {
          const found = binCandidates({
            binPath: s.binPath,
            pluginDir: this.plugin.getPluginDir(),
          }).find((c) => c.exists);
          if (found) {
            new Notice(`sysrec を検出: ${found.path}（${found.origin}）`);
          } else {
            new Notice("sysrec が見つかりません。「npm run build-sysrec」でビルドしてください。");
          }
        })
    );

    new Setting(containerEl)
      .setName("診断を実行（doctor）")
      .setDesc("バイナリ・権限・状態ディレクトリの状態をチェックします。")
      .addButton((btn) =>
        btn
          .setButtonText("診断を開く")
          .setCta()
          .onClick(() => new DoctorModal(this.app, this.plugin).open())
      );

    // --- 保存先 ---
    this.heading("保存先");

    this.bindToggle(
      "Vault 内に保存",
      "オンなら Vault 相対パスに保存し ![[…]] で埋め込めます。オフなら絶対パス。",
      () => s.saveInVault,
      (v) => (s.saveInVault = v)
    );

    this.bindText(
      "既定の保存先ディレクトリ",
      "録音ビューの初期値。Vault 内なら Vault 相対（例: Recordings）。",
      "Recordings",
      () => s.defaultSaveDir,
      (v) => (s.defaultSaveDir = v)
    );

    this.bindText(
      "状態ディレクトリ（作業フォルダ）",
      "録音中の音声と進行状況を Vault の外に一時保存する場所。" +
        "Obsidian が落ちたり再読み込みしても、ここを見て録音を復元・保存します。" +
        "ふつうは空欄（~/.meeting-recorder）のままでOK。",
      "~/.meeting-recorder",
      () => s.stateDir,
      (v) => (s.stateDir = v)
    );

    // --- 録音既定 ---
    this.heading("録音の既定値");

    this.bindDropdown(
      "既定のソース",
      "both = システム音声＋マイク。録音ビューで毎回変更できます。",
      [
        ["both", "both（システム＋マイク）"],
        ["system", "system（システム音声のみ）"],
        ["mic", "mic（マイクのみ）"],
      ],
      () => s.defaultSource,
      (v) => (s.defaultSource = v as RecorderSource)
    );

    this.bindToggle(
      "音量の自動調整（AGC）",
      "録音の音量を自動でそろえます。小さい声は持ち上げ、大きすぎる音は歪まないよう抑えるので、" +
        "聞き取り・文字起こしが安定します。オフにすると録れたままの生の音量になります。" +
        "（-16 dBFS へ正規化 + -1 dBFS リミッター）",
      () => s.defaultAgc,
      (v) => (s.defaultAgc = v)
    );

    // 入力デバイス（sysrec list-devices で非同期に populate）
    const deviceSetting = new Setting(containerEl)
      .setName("既定の入力デバイス（マイク）")
      .setDesc("録音ビューの初期値。空欄はシステム既定のマイク。");
    deviceSetting.addDropdown((d) => {
      d.addOption("", "既定");
      d.setValue(s.inputDeviceUid);
      d.onChange(async (v) => {
        s.inputDeviceUid = v;
        await this.plugin.saveSettings();
      });
      void this.plugin.listMicDevices().then((devices) => {
        for (const dev of devices) d.addOption(dev.uid, dev.name);
        d.setValue(s.inputDeviceUid);
      });
    });

    this.bindToggle(
      "モニター（自分のマイクを試聴）",
      "オンにすると、録音中に自分のマイク音声をリアルタイムで再生し、ちゃんと録れているか耳で確認できます。" +
        "必ずヘッドホンを使ってください（スピーカーだとマイクが自分の音を拾ってハウリングします）。" +
        "ここは録音ビューの初期値で、録音ごとに切り替えられます。",
      () => s.monitor,
      (v) => (s.monitor = v)
    );

    this.bindDropdown(
      "サンプルレート",
      "録音の音質。48000 Hz が高音質（既定・推奨）。数字を下げるとサンプルレートに合わせてビットレートも下がり、" +
        "ファイルは小さくなりますが音は粗くなります（Windows・macOS 共通で有効）。" +
        "文字起こし用の 16kHz 変換は別途自動で行うので、通常は 48000 のままでOK。",
      [
        ["48000", "48000 Hz（高音質・推奨）"],
        ["24000", "24000 Hz"],
        ["16000", "16000 Hz（文字起こし相当・小容量）"],
      ],
      () => String(s.sampleRate),
      (v) => (s.sampleRate = parseInt(v, 10))
    );

    this.bindDropdown(
      "チャンネル数",
      "モノラル（推奨）は相手＋自分を 1 本にまとめ、ファイルが約半分になります。会議は左右が同じ音になりがちなので通常はモノラルで十分です。" +
        "ステレオは 2 チャンネルで保存します（会議相手がモノラル配信だと左右ほぼ同じ内容になります）。",
      [
        ["1", "モノラル（推奨）"],
        ["2", "ステレオ"],
      ],
      () => (s.channels === 1 ? "1" : "2"),
      (v) => (s.channels = parseInt(v, 10))
    );

    // --- 停止時の動作 ---
    this.heading("停止時");

    this.bindToggle(
      "停止時にノートに埋め込み",
      "オンにすると、録音停止時に録音ファイルを ![[…]] でノートに埋め込みます。" +
        "埋め込み先（アクティブノート／指定ノート）は録音開始画面で選べます。Vault 内保存が必要です。",
      () => s.insertEmbedOnStop,
      (v) => (s.insertEmbedOnStop = v)
    );

    this.bindToggle(
      "デイリーノートにも追記",
      "停止時に今日のデイリーノートへ ![[…]] を追記します（コア「デイリーノート」有効時）。",
      () => s.linkToDailyNote,
      (v) => (s.linkToDailyNote = v)
    );

    // --- 会議アプリ前面での操作（Phase 4） ---
    this.heading("会議アプリ前面での操作");

    this.bindToggle(
      "常時前面ミニ制御ウィンドウ",
      "録音中、波形と停止ボタンを会議アプリの前面に浮かべます。",
      () => s.enableControlWindow,
      (v) => (s.enableControlWindow = v)
    );

    // --- 文字起こし（Phase 6・whisper.cpp 同梱） ---
    this.heading("文字起こし（whisper.cpp・同梱）");

    this.bindToggle(
      "停止時に自動で文字起こし",
      "録音停止後、m4a を文字起こしして結果をノートに追記します。",
      () => s.transcribeOnStop,
      (v) => (s.transcribeOnStop = v)
    );

    new Setting(containerEl)
      .setName("Whisper モデル")
      .setDesc(
        "精度と速度のトレードオフ。CPU のみで遅い場合は small / base が速い。" +
          "変更したら「診断（doctor）」でモデルを取得してください。"
      )
      .addDropdown((d) =>
        d
          .addOption("large-v3-turbo-q5_0", "large-v3-turbo（高精度・やや重い）")
          .addOption("small", "small（速い・バランス）")
          .addOption("base", "base（最速・軽量）")
          .setValue(this.plugin.settings.whisperCppModel || "large-v3-turbo-q5_0")
          .onChange(async (v) => {
            this.plugin.settings.whisperCppModel = v;
            await this.plugin.saveSettings();
          })
      );

    const whisperNote = containerEl.createEl("p", { cls: "rmr-settings-note" });
    whisperNote.setText(
      "whisper.cpp バイナリは自動検出されます。選んだモデルの入手・状態確認は「診断（doctor）」から行えます。"
    );

    this.bindText(
      "言語",
      "例: ja / en / auto。",
      "ja",
      () => s.transcribeLanguage,
      (v) => (s.transcribeLanguage = v)
    );
  }

  /** セクション見出し。 */
  private heading(name: string): void {
    new Setting(this.containerEl).setName(name).setHeading();
  }

  /** boolean 設定のトグル行。 */
  private bindToggle(
    name: string,
    desc: string,
    get: () => boolean,
    set: (v: boolean) => void
  ): void {
    new Setting(this.containerEl)
      .setName(name)
      .setDesc(desc)
      .addToggle((t) =>
        t.setValue(get()).onChange(async (v) => {
          set(v);
          await this.plugin.saveSettings();
        })
      );
  }

  /** テキスト設定行（前後空白は trim して保存）。 */
  private bindText(
    name: string,
    desc: string,
    placeholder: string,
    get: () => string,
    set: (v: string) => void
  ): void {
    new Setting(this.containerEl)
      .setName(name)
      .setDesc(desc)
      .addText((text) =>
        text
          .setPlaceholder(placeholder)
          .setValue(get())
          .onChange(async (v) => {
            set(v.trim());
            await this.plugin.saveSettings();
          })
      );
  }

  /** ドロップダウン設定行。options は [value, label] の配列。 */
  private bindDropdown(
    name: string,
    desc: string,
    options: [string, string][],
    get: () => string,
    set: (v: string) => void
  ): void {
    new Setting(this.containerEl)
      .setName(name)
      .setDesc(desc)
      .addDropdown((d) => {
        for (const [value, label] of options) d.addOption(value, label);
        d.setValue(get()).onChange(async (v) => {
          set(v);
          await this.plugin.saveSettings();
        });
      });
  }
}
