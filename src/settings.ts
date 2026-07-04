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
  translateToEnglish: boolean;
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
  translateToEnglish: false,
};

export class RMRSettingTab extends PluginSettingTab {
  plugin: RemoteMeetingRecorderPlugin;

  constructor(app: App, plugin: RemoteMeetingRecorderPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // --- バイナリ ---
    new Setting(containerEl).setName("録音エンジン（sysrec）").setHeading();

    const binSetting = new Setting(containerEl)
      .setName("バイナリパス")
      .setDesc(
        "空欄でOK。録音・診断のたびに native/sysrec/sysrec → bin/sysrec → PATH の順で自動検出します。" +
          "「検出」は今どこで見つかるかを確認するだけのボタンです（押さなくても録音できます／設定は保存されません）。"
      );
    binSetting.addText((text) =>
      text
        .setPlaceholder("（自動検出）")
        .setValue(this.plugin.settings.binPath)
        .onChange(async (value) => {
          this.plugin.settings.binPath = value.trim();
          await this.plugin.saveSettings();
        })
    );
    binSetting.addButton((btn) =>
      btn
        .setButtonText("検出")
        .setTooltip("今どこで見つかるかを確認します（設定は変更しません）")
        .onClick(() => {
          const found = binCandidates({
            binPath: this.plugin.settings.binPath,
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
    new Setting(containerEl).setName("保存先").setHeading();

    new Setting(containerEl)
      .setName("Vault 内に保存")
      .setDesc("オンなら Vault 相対パスに保存し ![[…]] で埋め込めます。オフなら絶対パス。")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.saveInVault).onChange(async (v) => {
          this.plugin.settings.saveInVault = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("既定の保存先ディレクトリ")
      .setDesc("録音ビューの初期値。Vault 内なら Vault 相対（例: Recordings）。")
      .addText((text) =>
        text
          .setPlaceholder("Recordings")
          .setValue(this.plugin.settings.defaultSaveDir)
          .onChange(async (v) => {
            this.plugin.settings.defaultSaveDir = v.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("状態ディレクトリ（作業フォルダ）")
      .setDesc(
        "録音中の音声と進行状況を Vault の外に一時保存する場所。" +
          "Obsidian が落ちたり再読み込みしても、ここを見て録音を復元・保存します。" +
          "ふつうは空欄（~/.meeting-recorder）のままでOK。"
      )
      .addText((text) =>
        text
          .setPlaceholder("~/.meeting-recorder")
          .setValue(this.plugin.settings.stateDir)
          .onChange(async (v) => {
            this.plugin.settings.stateDir = v.trim();
            await this.plugin.saveSettings();
          })
      );

    // --- 録音既定 ---
    new Setting(containerEl).setName("録音の既定値").setHeading();

    new Setting(containerEl)
      .setName("既定のソース")
      .setDesc("both = システム音声＋マイク。録音ビューで毎回変更できます。")
      .addDropdown((d) =>
        d
          .addOption("both", "both（システム＋マイク）")
          .addOption("system", "system（システム音声のみ）")
          .addOption("mic", "mic（マイクのみ）")
          .setValue(this.plugin.settings.defaultSource)
          .onChange(async (v) => {
            this.plugin.settings.defaultSource = v as RecorderSource;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("音量の自動調整（AGC）")
      .setDesc(
        "録音の音量を自動でそろえます。小さい声は持ち上げ、大きすぎる音は歪まないよう抑えるので、" +
          "聞き取り・文字起こしが安定します。オフにすると録れたままの生の音量になります。" +
          "（-16 dBFS へ正規化 + -1 dBFS リミッター）"
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.defaultAgc).onChange(async (v) => {
          this.plugin.settings.defaultAgc = v;
          await this.plugin.saveSettings();
        })
      );

    // 入力デバイス（sysrec list-devices で非同期に populate）
    const deviceSetting = new Setting(containerEl)
      .setName("既定の入力デバイス（マイク）")
      .setDesc("録音ビューの初期値。空欄はシステム既定のマイク。");
    deviceSetting.addDropdown((d) => {
      d.addOption("", "既定");
      d.setValue(this.plugin.settings.inputDeviceUid);
      d.onChange(async (v) => {
        this.plugin.settings.inputDeviceUid = v;
        await this.plugin.saveSettings();
      });
      void this.plugin.listMicDevices().then((devices) => {
        for (const dev of devices) d.addOption(dev.uid, dev.name);
        d.setValue(this.plugin.settings.inputDeviceUid);
      });
    });

    new Setting(containerEl)
      .setName("モニター（自分のマイクを試聴）")
      .setDesc(
        "オンにすると、録音中に自分のマイク音声をリアルタイムで再生し、ちゃんと録れているか耳で確認できます。" +
          "必ずヘッドホンを使ってください（スピーカーだとマイクが自分の音を拾ってハウリングします）。" +
          "ここは録音ビューの初期値で、録音ごとに切り替えられます。"
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.monitor).onChange(async (v) => {
          this.plugin.settings.monitor = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("サンプルレート")
      .setDesc(
        "録音の音質。48000 Hz が高音質（既定・推奨）。数字を下げるとファイルは小さくなりますが音は粗くなります。" +
          "文字起こし用の 16kHz 変換は別途自動で行うので、通常は 48000 のままでOK。"
      )
      .addDropdown((dd) =>
        dd
          .addOption("48000", "48000 Hz（高音質・推奨）")
          .addOption("24000", "24000 Hz")
          .addOption("16000", "16000 Hz（文字起こし相当・小容量）")
          .setValue(String(this.plugin.settings.sampleRate))
          .onChange(async (v) => {
            this.plugin.settings.sampleRate = parseInt(v, 10);
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("チャンネル数")
      .setDesc(
        "モノラル（推奨）は相手＋自分を 1 本にまとめ、ファイルが約半分になります。会議は左右が同じ音になりがちなので通常はモノラルで十分です。" +
          "ステレオは 2 チャンネルで保存します（会議相手がモノラル配信だと左右ほぼ同じ内容になります）。"
      )
      .addDropdown((dd) =>
        dd
          .addOption("1", "モノラル（推奨）")
          .addOption("2", "ステレオ")
          .setValue(this.plugin.settings.channels === 1 ? "1" : "2")
          .onChange(async (v) => {
            this.plugin.settings.channels = parseInt(v, 10);
            await this.plugin.saveSettings();
          })
      );

    // --- 停止時の動作 ---
    new Setting(containerEl).setName("停止時").setHeading();

    new Setting(containerEl)
      .setName("停止時にノートに埋め込み")
      .setDesc(
        "オンにすると、録音停止時に録音ファイルを ![[…]] でノートに埋め込みます。" +
          "埋め込み先（アクティブノート／指定ノート）は録音開始画面で選べます。Vault 内保存が必要です。"
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.insertEmbedOnStop).onChange(async (v) => {
          this.plugin.settings.insertEmbedOnStop = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("デイリーノートにも追記")
      .setDesc("停止時に今日のデイリーノートへ ![[…]] を追記します（コア「デイリーノート」有効時）。")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.linkToDailyNote).onChange(async (v) => {
          this.plugin.settings.linkToDailyNote = v;
          await this.plugin.saveSettings();
        })
      );

    // --- 会議アプリ前面での操作（Phase 4） ---
    new Setting(containerEl).setName("会議アプリ前面での操作").setHeading();

    new Setting(containerEl)
      .setName("常時前面ミニ制御ウィンドウ")
      .setDesc("録音中、波形と停止ボタンを会議アプリの前面に浮かべます。")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.enableControlWindow).onChange(async (v) => {
          this.plugin.settings.enableControlWindow = v;
          await this.plugin.saveSettings();
        })
      );

    // --- 文字起こし（Phase 6・whisper.cpp 同梱） ---
    new Setting(containerEl).setName("文字起こし（whisper.cpp・同梱）").setHeading();

    new Setting(containerEl)
      .setName("停止時に自動で文字起こし")
      .setDesc("録音停止後、m4a を文字起こしして結果をノートに追記します。")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.transcribeOnStop).onChange(async (v) => {
          this.plugin.settings.transcribeOnStop = v;
          await this.plugin.saveSettings();
        })
      );

    const whisperNote = containerEl.createEl("p", { cls: "rmr-settings-note" });
    whisperNote.setText(
      "モデルと whisper.cpp バイナリは自動検出されます。モデルの入手・状態確認は「診断（doctor）」から行えます。"
    );

    new Setting(containerEl)
      .setName("言語")
      .setDesc("例: ja / en / auto。")
      .addText((text) =>
        text
          .setPlaceholder("ja")
          .setValue(this.plugin.settings.transcribeLanguage)
          .onChange(async (v) => {
            this.plugin.settings.transcribeLanguage = v.trim();
            await this.plugin.saveSettings();
          })
      );
  }
}
