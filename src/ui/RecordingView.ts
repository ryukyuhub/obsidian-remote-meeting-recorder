import { ItemView, Notice, WorkspaceLeaf, setIcon } from "obsidian";
import type RemoteMeetingRecorderPlugin from "../main";
import type { RecorderSource } from "../types";
import { WebAudioTap } from "../audio/webAudioTap";
import { WaveformRenderer } from "../audio/waveform";
import { defaultFilename, formatElapsed } from "../util/time";

export const RECORDING_VIEW_TYPE = "rmr-recording-view";

/**
 * 主要 UI（設計書 §9.1）。タイトル → ライブ波形 → トランスポート → 設定パネル。
 * 録音の都度 Source / Save to を確認し、同意チェックで録音ボタンを gate。
 */
export class RecordingView extends ItemView {
  plugin: RemoteMeetingRecorderPlugin;

  // 録音ごとの編集値（設定でプリセット・録音中は lock）
  private vSource: RecorderSource;
  private vSaveDir: string;
  private vTitle: string;
  private vAgc: boolean;
  private consent = false;

  // ライブ波形（マイク・表示専用）
  private tap: WebAudioTap | null = null;
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
    // 録音中にビューを開き直したらマイクメーターを復帰（mic/both のみ）
    const active = this.plugin.activeRecording;
    if (active && active.source !== "system" && this.canvasEl && !this.tap) {
      await this.startTap();
    }
  }

  async onClose(): Promise<void> {
    this.stopTap();
    this.plugin.unregisterRecordingView(this);
  }

  private get recording(): boolean {
    return this.plugin.activeRecording != null;
  }

  /** 外部から呼ばれる: 録音状態が変わったので再描画。 */
  refresh(): void {
    this.render();
  }

  /** 外部から呼ばれる: 経過時間の更新（status bar と同期）。 */
  setElapsed(sec: number): void {
    if (this.timerEl) this.timerEl.setText(formatElapsed(sec));
  }

  /** 終端イベント受信: タップ停止 + 再描画。 */
  onTerminal(): void {
    this.stopTap();
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
    const recBtn = transport.createEl("button", { cls: "rmr-btn rmr-btn-rec" });
    setIcon(recBtn.createSpan(), "circle");
    recBtn.createSpan({ text: " 録音" });
    recBtn.disabled = this.recording || !this.consent;
    recBtn.addEventListener("click", () => void this.onRecord());

    const pauseBtn = transport.createEl("button", { cls: "rmr-btn rmr-btn-pause" });
    setIcon(pauseBtn.createSpan(), "pause");
    pauseBtn.disabled = true;
    pauseBtn.setAttr("title", "一時停止は今後のバージョンで対応します");

    const stopBtn = transport.createEl("button", { cls: "rmr-btn rmr-btn-stop" });
    setIcon(stopBtn.createSpan(), "square");
    stopBtn.createSpan({ text: " 停止" });
    stopBtn.disabled = !this.recording;
    stopBtn.addEventListener("click", () => void this.onStop());

    // --- 設定パネル ---
    const panel = root.createDiv({ cls: "rmr-panel" });
    this.buildSourceRow(panel, active != null);
    this.buildSaveRow(panel, active != null);
    this.buildStaticRow(panel, "Format", "M4A（固定）");
    this.buildAgcRow(panel, active != null);

    if (!active) {
      // 同意チェック（録音ボタンを gate）
      const consentRow = panel.createDiv({ cls: "rmr-consent" });
      const cb = consentRow.createEl("input", { attr: { type: "checkbox", id: "rmr-consent" } });
      cb.checked = this.consent;
      cb.addEventListener("change", () => {
        this.consent = cb.checked;
        recBtn.disabled = this.recording || !this.consent;
      });
      consentRow.createEl("label", {
        text: " 参加者に録音の告知・同意を得た",
        attr: { for: "rmr-consent" },
      });
    } else {
      panel.createDiv({
        cls: "rmr-recording-note",
        text: `録音中（${sourceLabel(active.source)}）— 設定は停止までロックされます`,
      });
    }

    root.createDiv({
      cls: "rmr-warn",
      text: "⚠ MacBook の蓋を閉じると録音は止まります",
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

  private buildSourceRow(panel: HTMLElement, locked: boolean): void {
    const row = panel.createDiv({ cls: "rmr-row" });
    row.createDiv({ cls: "rmr-row-label", text: "Source" });
    const opts = row.createDiv({ cls: "rmr-row-control rmr-radios" });
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
    const row = panel.createDiv({ cls: "rmr-row" });
    row.createDiv({ cls: "rmr-row-label", text: "Save to" });
    const control = row.createDiv({ cls: "rmr-row-control" });
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

  private buildStaticRow(panel: HTMLElement, label: string, value: string): void {
    const row = panel.createDiv({ cls: "rmr-row" });
    row.createDiv({ cls: "rmr-row-label", text: label });
    row.createDiv({ cls: "rmr-row-control rmr-static", text: value });
  }

  private buildAgcRow(panel: HTMLElement, locked: boolean): void {
    const row = panel.createDiv({ cls: "rmr-row" });
    row.createDiv({ cls: "rmr-row-label", text: "Auto gain" });
    const control = row.createDiv({ cls: "rmr-row-control" });
    const active = this.plugin.activeRecording;
    const cb = control.createEl("input", { attr: { type: "checkbox" } });
    cb.checked = active ? active.agc === "on" : this.vAgc;
    cb.disabled = locked;
    cb.addEventListener("change", () => (this.vAgc = cb.checked));
  }

  // ================================================================
  private async onRecord(): Promise<void> {
    if (this.recording) return;
    if (!this.consent) {
      new Notice("参加者の同意チェックを入れてください。");
      return;
    }
    try {
      await this.plugin.startRecordingFromView({
        source: this.vSource,
        saveDirDisplay: this.vSaveDir,
        filename: this.vTitle,
        agc: this.vAgc,
        label: this.vTitle,
      });
    } catch (e) {
      new Notice(`録音を開始できませんでした: ${(e as Error).message}`);
      this.render();
      return;
    }
    // 先に録音状態で再描画（canvas を生成）してから、その canvas にタップを繋ぐ
    this.render();
    if (this.plugin.activeRecording && this.plugin.activeRecording.source !== "system") {
      await this.startTap();
    }
  }

  private async onStop(): Promise<void> {
    if (!this.recording) return;
    this.stopTap();
    await this.plugin.stopActiveRecording();
    this.render();
  }

  private async startTap(): Promise<void> {
    if (!this.canvasEl) return; // メーター領域が無い（system など）
    try {
      this.tap = new WebAudioTap();
      await this.tap.start(this.plugin.settings.inputDeviceUid || undefined, false);
      this.waveform = new WaveformRenderer(this.canvasEl, () => this.tap?.getLevel() ?? 0);
      this.waveform.start();
    } catch (e) {
      // マイクタップ失敗は録音自体には影響しない（表示専用）
      new Notice(`マイクメーターを開始できませんでした（録音は継続）: ${(e as Error).message}`);
      this.stopTap();
    }
  }

  private stopTap(): void {
    this.waveform?.stop();
    this.waveform = null;
    this.tap?.stop();
    this.tap = null;
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
