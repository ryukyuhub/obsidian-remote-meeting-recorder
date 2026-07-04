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
  enableGlobalHotkey: boolean;
  globalHotkeyAccelerator: string;
  enableControlWindow: boolean;
  // 文字起こし（Phase 6・設計書 §15）
  transcribeOnStop: boolean;
  whisperServerUrl: string;
  whisperModel: string;
  transcribeLanguage: string;
  translateToEnglish: boolean;
  summarizeOnTranscribe: boolean;
  aiProvider: string;
  aiModel: string;
  aiApiKey: string;
  transcriptPostAction: TranscriptPostAction;
}

export type TranscriptPostAction = "transcript" | "summary" | "full";

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
  enableGlobalHotkey: false,
  globalHotkeyAccelerator: "CommandOrControl+Shift+R",
  enableControlWindow: false,
  transcribeOnStop: false,
  whisperServerUrl: "http://127.0.0.1:5678",
  whisperModel: "",
  transcribeLanguage: "ja",
  translateToEnglish: false,
  summarizeOnTranscribe: false,
  aiProvider: "anthropic",
  aiModel: "",
  aiApiKey: "",
  transcriptPostAction: "full",
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

    // --- 会議アプリ前面での操作（Phase 4） ---
    containerEl.createEl("h3", { text: "会議アプリ前面での操作" });

    new Setting(containerEl)
      .setName("常時前面ミニ制御ウィンドウ")
      .setDesc("録音中、波形と停止ボタンを会議アプリの前面に浮かべます。")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.enableControlWindow).onChange(async (v) => {
          this.plugin.settings.enableControlWindow = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("グローバルホットキー")
      .setDesc("Obsidian が非フォーカスでも効くホットキー。録音中は停止、停止中は録音ビューを開きます。")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.enableGlobalHotkey).onChange(async (v) => {
          this.plugin.settings.enableGlobalHotkey = v;
          await this.plugin.saveSettings();
          this.plugin.registerHotkeys();
        })
      );

    new Setting(containerEl)
      .setName("ホットキーの割り当て")
      .setDesc("Electron 形式（例: CommandOrControl+Shift+R）。")
      .addText((text) =>
        text
          .setPlaceholder("CommandOrControl+Shift+R")
          .setValue(this.plugin.settings.globalHotkeyAccelerator)
          .onChange(async (v) => {
            this.plugin.settings.globalHotkeyAccelerator = v.trim();
            await this.plugin.saveSettings();
            this.plugin.registerHotkeys();
          })
      );

    const note = containerEl.createEl("p", { cls: "rmr-settings-note" });
    note.setText(
      "⚠ macOS ではグローバルホットキーに「アクセシビリティ」権限が必要です。" +
        "効かない場合は システム設定 > プライバシーとセキュリティ > アクセシビリティ で Obsidian を許可してください。"
    );

    // --- 文字起こし（Phase 6・ローカル Whisper） ---
    containerEl.createEl("h3", { text: "文字起こし（ローカル Whisper）" });

    new Setting(containerEl)
      .setName("停止時に自動で文字起こし")
      .setDesc("録音停止後、m4a をローカル Whisper サーバへ送り、結果をノートに追記します。")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.transcribeOnStop).onChange(async (v) => {
          this.plugin.settings.transcribeOnStop = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Whisper サーバ URL")
      .setDesc("既定 http://127.0.0.1:5678（ローカル MLX サーバ）。")
      .addText((text) =>
        text
          .setPlaceholder("http://127.0.0.1:5678")
          .setValue(this.plugin.settings.whisperServerUrl)
          .onChange(async (v) => {
            this.plugin.settings.whisperServerUrl = v.trim();
            await this.plugin.saveSettings();
          })
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

    new Setting(containerEl)
      .setName("Whisper モデル")
      .setDesc("空欄はサーバのロード済みモデル。")
      .addText((text) =>
        text
          .setPlaceholder("(サーバ既定)")
          .setValue(this.plugin.settings.whisperModel)
          .onChange(async (v) => {
            this.plugin.settings.whisperModel = v.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("ノートへの出力")
      .setDesc("全文のみ / 要約のみ / 両方。")
      .addDropdown((d) =>
        d
          .addOption("transcript", "全文のみ")
          .addOption("summary", "要約のみ")
          .addOption("full", "全文＋要約")
          .setValue(this.plugin.settings.transcriptPostAction)
          .onChange(async (v) => {
            this.plugin.settings.transcriptPostAction = v as TranscriptPostAction;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("AI 要約を生成")
      .setDesc("文字起こし後に要約・アクションアイテムを抽出します（AI キーが必要）。")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.summarizeOnTranscribe).onChange(async (v) => {
          this.plugin.settings.summarizeOnTranscribe = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("AI プロバイダ")
      .addDropdown((d) =>
        d
          .addOption("anthropic", "Anthropic（Claude）")
          .addOption("openai", "OpenAI")
          .addOption("ollama", "Ollama（ローカル）")
          .setValue(this.plugin.settings.aiProvider)
          .onChange(async (v) => {
            this.plugin.settings.aiProvider = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("AI モデル")
      .setDesc("空欄はプロバイダ既定（Anthropic は claude-sonnet-4）。")
      .addText((text) =>
        text
          .setPlaceholder("(既定)")
          .setValue(this.plugin.settings.aiModel)
          .onChange(async (v) => {
            this.plugin.settings.aiModel = v.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("AI API キー")
      .setDesc("要約用。サーバ経由で AI プロバイダに渡されます（Vault の設定に保存されます）。")
      .addText((text) => {
        text
          .setPlaceholder("sk-ant-...")
          .setValue(this.plugin.settings.aiApiKey)
          .onChange(async (v) => {
            this.plugin.settings.aiApiKey = v.trim();
            await this.plugin.saveSettings();
          });
        text.inputEl.type = "password";
      });
  }
}
