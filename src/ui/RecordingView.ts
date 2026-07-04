import { ItemView, Notice, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import type RemoteMeetingRecorderPlugin from "../main";
import type { RecorderSource } from "../types";
import type { MicDevice } from "../recorder/devices";
import { WaveformRenderer } from "../audio/waveform";
import { defaultFilename, formatElapsed } from "../util/time";
import { pickMarkdownNote } from "./NotePicker";

export const RECORDING_VIEW_TYPE = "rmr-recording-view";

/**
 * 主要 UI（設計書 §9.1）。タイトル → ライブ波形 → トランスポート → 設定パネル。
 * 録音の都度 Source / Save to を確認する。
 */
export class RecordingView extends ItemView {
  plugin: RemoteMeetingRecorderPlugin;

  // 録音ごとの編集値（設定でプリセット・録音中は lock）
  private vSource: RecorderSource;
  private vSaveDir: string;
  private vTitle: string;
  private vAgc: boolean;
  private vMicDevice: string;
  private vMonitor: boolean;

  // 埋め込み先ノート（未選択なら停止時に埋め込みしない）
  private vEmbedFile: TFile | null = null;

  // マイクデバイス一覧（list-devices・onOpen で取得）
  private micDevices: MicDevice[] = [];

  // ライブ波形（レベルはプラグイン所有のマイクタップから読む）
  private waveform: WaveformRenderer | null = null;

  // DOM 参照
  private timerEl: HTMLElement | null = null;
  private waveWrapEl: HTMLElement | null = null;
  private canvasEl: HTMLCanvasElement | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: RemoteMeetingRecorderPlugin) {
    super(leaf);
    this.plugin = plugin;
    const s = plugin.settings;
    this.vSource = s.defaultSource;
    this.vSaveDir = s.defaultSaveDir;
    this.vTitle = defaultFilename();
    this.vAgc = s.defaultAgc;
    this.vMicDevice = s.inputDeviceUid;
    this.vMonitor = s.monitor;
  }

  getViewType(): string {
    return RECORDING_VIEW_TYPE;
  }
  getDisplayText(): string {
    return "会議録音";
  }
  getIcon(): string {
    return "circle-dot";
  }

  async onOpen(): Promise<void> {
    this.plugin.registerRecordingView(this);
    this.render();
    // マイク一覧を取得して Input ドロップダウンを更新
    try {
      this.micDevices = await this.plugin.listMicDevices();
      if (!this.plugin.activeRecording) this.render();
    } catch {
      // 取得失敗は「既定」のみで続行
    }
    // 録音中にビューを開き直したらマイクメーターを復帰（mic/both のみ）
    const active = this.plugin.activeRecording;
    if (active && active.source !== "system" && this.canvasEl) {
      this.startWaveform();
    }
  }

  async onClose(): Promise<void> {
    this.stopWaveform(); // タップはプラグイン所有なので止めない
    this.plugin.unregisterRecordingView(this);
  }

  private get recording(): boolean {
    return this.plugin.activeRecording != null;
  }

  /** 外部から呼ばれる: 録音状態が変わったので再描画。 */
  refresh(): void {
    this.render();
  }

  /** 外部（ファイル右クリック等）から埋め込み先ノートを設定して再描画。録音中は変更不可。 */
  setEmbedTarget(file: TFile): void {
    if (this.recording) {
      new Notice("録音中は埋め込み先を変更できません。");
      return;
    }
    this.vEmbedFile = file;
    this.render();
    new Notice(`「${file.basename}」に録音を埋め込みます。録音を開始してください。`);
  }

  /** 外部から呼ばれる: 経過時間の更新（status bar と同期）。 */
  setElapsed(sec: number): void {
    if (this.timerEl) this.timerEl.setText(formatElapsed(sec));
  }

  /** 終端イベント受信: 波形停止 + 再描画。 */
  onTerminal(): void {
    this.stopWaveform();
    this.render();
  }

  // ================================================================
  private render(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass("rmr-view");

    const active = this.plugin.activeRecording;

    // --- タイトル ---
    const titleRow = root.createDiv({ cls: "rmr-title-row" });
    if (active) {
      titleRow.createEl("div", { cls: "rmr-title-static", text: active.label || this.vTitle });
    } else {
      const titleInput = titleRow.createEl("input", {
        cls: "rmr-title-input",
        attr: { type: "text", placeholder: defaultFilename() },
      });
      titleInput.value = this.vTitle;
      titleInput.addEventListener("input", () => (this.vTitle = titleInput.value));
    }

    // --- 波形 / 経過 ---
    this.waveWrapEl = root.createDiv({ cls: "rmr-wave" });
    this.timerEl = root.createDiv({ cls: "rmr-timer", text: "0:00" });
    this.buildWaveArea(active != null);

    // --- トランスポート ---
    const transport = root.createDiv({ cls: "rmr-transport" });
    this.addTransportButton(transport, "rmr-btn-rec", "circle", " 録音", this.recording, () =>
      void this.onRecord()
    );
    const pauseBtn = this.addTransportButton(transport, "rmr-btn-pause", "pause", "", true);
    pauseBtn.setAttr("title", "一時停止は今後のバージョンで対応します");
    this.addTransportButton(transport, "rmr-btn-stop", "square", " 停止", !this.recording, () =>
      void this.onStop()
    );

    // --- 設定パネル ---
    const panel = root.createDiv({ cls: "rmr-panel" });
    this.buildSourceRow(panel, active != null);
    this.buildSaveRow(panel, active != null);
    if (!active) this.buildEmbedRow(panel);
    this.buildInputRow(panel, active != null);
    this.buildMonitorRow(panel);
    this.buildStaticRow(panel, "Format", "M4A（固定）");
    this.buildAgcRow(panel, active != null);

    if (active) {
      panel.createDiv({
        cls: "rmr-recording-note",
        text: `録音中（${sourceLabel(active.source)}）— 設定は停止までロックされます`,
      });
    }

    root.createDiv({
      cls: "rmr-warn",
      text:
        process.platform === "win32"
          ? "⚠ ノート PC の蓋を閉じる／スリープすると録音は止まります"
          : "⚠ MacBook の蓋を閉じる／スリープすると録音は止まります",
    });
  }

  private buildWaveArea(isRecording: boolean): void {
    const wrap = this.waveWrapEl;
    if (!wrap) return;
    wrap.empty();
    const active = this.plugin.activeRecording;
    const showMeter = isRecording && active != null && active.source !== "system";
    if (showMeter) {
      this.canvasEl = wrap.createEl("canvas", { cls: "rmr-canvas" });
    } else if (isRecording) {
      wrap.createDiv({ cls: "rmr-wave-msg", text: "システム音声を録音中…" });
    } else {
      wrap.createDiv({ cls: "rmr-wave-msg", text: "待機中" });
    }
  }

  /** 設定パネルの1行（ラベル＋コントロール枠）を作り、コントロール枠を返す。 */
  private addRow(panel: HTMLElement, label: string, controlCls?: string): HTMLElement {
    const row = panel.createDiv({ cls: "rmr-row" });
    row.createDiv({ cls: "rmr-row-label", text: label });
    const cls = controlCls ? `rmr-row-control ${controlCls}` : "rmr-row-control";
    return row.createDiv({ cls });
  }

  /** トランスポートボタン（アイコン＋任意ラベル）を作る。text 空ならアイコンのみ。 */
  private addTransportButton(
    parent: HTMLElement,
    cls: string,
    icon: string,
    text: string,
    disabled: boolean,
    onClick?: () => void
  ): HTMLButtonElement {
    const btn = parent.createEl("button", { cls: `rmr-btn ${cls}` });
    setIcon(btn.createSpan(), icon);
    if (text) btn.createSpan({ text });
    btn.disabled = disabled;
    if (onClick) btn.addEventListener("click", onClick);
    return btn;
  }

  private buildSourceRow(panel: HTMLElement, locked: boolean): void {
    const opts = this.addRow(panel, "Source", "rmr-radios");
    const active = this.plugin.activeRecording;
    const current = active ? active.source : this.vSource;
    (["mic", "system", "both"] as RecorderSource[]).forEach((src) => {
      const lbl = opts.createEl("label", { cls: "rmr-radio" });
      const input = lbl.createEl("input", { attr: { type: "radio", name: "rmr-source" } });
      input.checked = current === src;
      input.disabled = locked;
      input.addEventListener("change", () => {
        if (input.checked) this.vSource = src;
      });
      lbl.createSpan({ text: sourceLabel(src) });
    });
  }

  private buildSaveRow(panel: HTMLElement, locked: boolean): void {
    const control = this.addRow(panel, "Save to");
    const input = control.createEl("input", {
      cls: "rmr-save-input",
      attr: { type: "text", placeholder: "Recordings" },
    });
    input.value = this.vSaveDir;
    input.disabled = locked;
    input.addEventListener("input", () => (this.vSaveDir = input.value));
    control.createSpan({
      cls: "rmr-hint",
      text: this.plugin.settings.saveInVault ? "（Vault 内）" : "（絶対パス）",
    });
  }

  /** 埋め込み先ノートの選択。停止時埋め込みが有効なときだけ表示。未選択なら埋め込みしない。 */
  private buildEmbedRow(panel: HTMLElement): void {
    if (!this.plugin.settings.insertEmbedOnStop) return;
    const control = this.addRow(panel, "埋め込み先", "rmr-embed-control");

    const pickBtn = control.createEl("button", { cls: "rmr-embed-pick" });
    const clearBtn = control.createEl("button", { cls: "rmr-embed-clear", text: "×" });
    clearBtn.setAttr("aria-label", "選択を解除");
    const hint = control.createSpan({ cls: "rmr-hint" });

    const sync = (): void => {
      if (this.vEmbedFile) {
        pickBtn.setText(this.vEmbedFile.basename);
        clearBtn.removeClass("rmr-hidden");
        hint.setText("");
      } else {
        pickBtn.setText("ノートを選択…");
        clearBtn.addClass("rmr-hidden");
        hint.setText("未選択のまま録音すると埋め込みしません");
      }
    };
    sync();

    pickBtn.addEventListener("click", () => void this.chooseEmbedNote(sync));
    clearBtn.addEventListener("click", () => {
      this.vEmbedFile = null;
      sync();
    });
  }

  /** 埋め込み先ノートをモーダルで選ばせる。選択後に UI を同期。 */
  private async chooseEmbedNote(sync: () => void): Promise<void> {
    const file = await pickMarkdownNote(this.app);
    if (file) this.vEmbedFile = file;
    sync();
  }

  private buildInputRow(panel: HTMLElement, locked: boolean): void {
    const control = this.addRow(panel, "Input");
    const select = control.createEl("select", { cls: "rmr-select dropdown" });
    const optDefault = select.createEl("option", { text: "既定", value: "" });
    if (!this.vMicDevice) optDefault.selected = true;
    for (const dev of this.micDevices) {
      const opt = select.createEl("option", { text: dev.name, value: dev.uid });
      if (dev.uid === this.vMicDevice) opt.selected = true;
    }
    select.disabled = locked;
    select.addEventListener("change", () => (this.vMicDevice = select.value));
  }

  private buildMonitorRow(panel: HTMLElement): void {
    const control = this.addRow(panel, "Monitor");
    const cb = control.createEl("input", { attr: { type: "checkbox" } });
    cb.checked = this.vMonitor;
    cb.addEventListener("change", () => {
      this.vMonitor = cb.checked;
      this.plugin.setMonitor(cb.checked); // 録音中でも表示専用タップに即反映
    });
    control.createSpan({ cls: "rmr-hint", text: "入力を試聴（ヘッドホン推奨）" });
  }

  private buildStaticRow(panel: HTMLElement, label: string, value: string): void {
    this.addRow(panel, label, "rmr-static").setText(value);
  }

  private buildAgcRow(panel: HTMLElement, locked: boolean): void {
    const control = this.addRow(panel, "Auto gain");
    const active = this.plugin.activeRecording;
    const cb = control.createEl("input", { attr: { type: "checkbox" } });
    cb.checked = active ? active.agc === "on" : this.vAgc;
    cb.disabled = locked;
    cb.addEventListener("change", () => (this.vAgc = cb.checked));
  }

  // ================================================================
  private async onRecord(): Promise<void> {
    if (this.recording) return;
    try {
      await this.plugin.startRecordingFromView({
        source: this.vSource,
        saveDirDisplay: this.vSaveDir,
        filename: this.vTitle,
        agc: this.vAgc,
        label: this.vTitle,
        micDevice: this.vMicDevice,
        monitor: this.vMonitor,
        embedNotePath: this.vEmbedFile?.path,
      });
    } catch (e) {
      new Notice(`録音を開始できませんでした: ${(e as Error).message}`);
      this.render();
      return;
    }
    // 先に録音状態で再描画（canvas を生成）してから波形を繋ぐ（タップはプラグインが起動）
    this.render();
    if (this.plugin.activeRecording && this.plugin.activeRecording.source !== "system") {
      this.startWaveform();
    }
  }

  private async onStop(): Promise<void> {
    if (!this.recording) return;
    this.stopWaveform();
    await this.plugin.stopActiveRecording();
    this.render();
  }

  /** プラグイン所有のマイクタップからレベルを読んで波形を描く。 */
  private startWaveform(): void {
    if (!this.canvasEl) return;
    this.stopWaveform();
    this.waveform = new WaveformRenderer(this.canvasEl, () => this.plugin.getMicLevel());
    this.waveform.start();
  }

  private stopWaveform(): void {
    this.waveform?.stop();
    this.waveform = null;
  }
}

function sourceLabel(src: RecorderSource): string {
  switch (src) {
    case "mic":
      return "マイク";
    case "system":
      return "システム音声";
    case "both":
      return "両方";
  }
}
