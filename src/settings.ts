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
}

export const DEFAULT_SETTINGS: RMRSettings = {
  binPath: "",
  defaultSaveDir: "Recordings",
  saveInVault: true,
  stateDir: "",
  sampleRate: 48000,
  channels: 2,
  defaultAgc: true,
  defaultSource: "both",
  monitor: false,
  inputDeviceUid: "",
  insertEmbedOnStop: true,
  linkToDailyNote: false,
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
    containerEl.createEl("h3", { text: "録音エンジン（sysrec）" });

    const binSetting = new Setting(containerEl)
      .setName("バイナリパス")
      .setDesc("空欄なら native/sysrec/sysrec → bin/sysrec → PATH の順に自動検出します。");
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
      btn.setButtonText("検出").onClick(() => {
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
    containerEl.createEl("h3", { text: "保存先" });

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
      .setName("状態ディレクトリ")
      .setDesc("セッション情報の保存先。空欄なら ~/.meeting-recorder。")
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
    containerEl.createEl("h3", { text: "録音の既定値" });

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
      .setName("Auto gain control（AGC）")
      .setDesc("既定オン（-16 dBFS 正規化 + -1 dBFS リミッター）。")
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
      .setName("モニター（入力の試聴）")
      .setDesc("録音ビューの初期値。マイク入力を出力へ流します（ヘッドホン推奨・ハウリング注意）。")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.monitor).onChange(async (v) => {
          this.plugin.settings.monitor = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("サンプルレート")
      .addText((text) =>
        text.setValue(String(this.plugin.settings.sampleRate)).onChange(async (v) => {
          const n = parseInt(v, 10);
          if (Number.isFinite(n) && n > 0) {
            this.plugin.settings.sampleRate = n;
            await this.plugin.saveSettings();
          }
        })
      );

    new Setting(containerEl)
      .setName("チャンネル数")
      .addText((text) =>
        text.setValue(String(this.plugin.settings.channels)).onChange(async (v) => {
          const n = parseInt(v, 10);
          if (Number.isFinite(n) && n > 0) {
            this.plugin.settings.channels = n;
            await this.plugin.saveSettings();
          }
        })
      );

    // --- 停止時の動作 ---
    containerEl.createEl("h3", { text: "停止時" });

    new Setting(containerEl)
      .setName("停止時に埋め込みを挿入")
      .setDesc("Vault 内保存なら録音開始時のノートに ![[…]] を挿入します。")
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
  }
}
