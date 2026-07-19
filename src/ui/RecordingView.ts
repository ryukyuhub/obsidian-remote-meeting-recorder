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
  // 手動ミキサー（Manual モード）と、ソース別ゲイン(dB)
  private vManualMix: boolean;
  private vSystemGainDb: number;
  private vMicGainDb: number;

  // 埋め込み先ノート（未選択なら停止時に埋め込みしない）
  private vEmbedFile: TFile | null = null;

  // マイクデバイス一覧（list-devices・onOpen で取得）
  private micDevices: MicDevice[] = [];

  // ライブ波形/メーター（ソースごとに 1 本。レベルは plugin.getSourceLevels() から読む）
  private waveforms: WaveformRenderer[] = [];
  private meterCanvases: { source: "system" | "mic"; canvas: HTMLCanvasElement }[] = [];

  // DOM 参照
  private timerEl: HTMLElement | null = null;
  private waveWrapEl: HTMLElement | null = null;

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
    this.vManualMix = s.enableManualMixer;
    this.vSystemGainDb = s.defaultSystemGainDb;
    this.vMicGainDb = s.defaultMicGainDb;
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
    // 録音中にビューを開き直したらメーターを復帰（buildWaveArea が canvas を用意済み）
    if (this.plugin.activeRecording && this.meterCanvases.length) {
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
    this.buildLevelRows(panel, active != null);

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

  /** 現在の source で表示すべきメーターのソース列（both=2本、単体=1本）。 */
  private meterSourcesFor(source: RecorderSource): ("system" | "mic")[] {
    if (source === "both") return ["system", "mic"];
    if (source === "system") return ["system"];
    return ["mic"];
  }

  private buildWaveArea(isRecording: boolean): void {
    const wrap = this.waveWrapEl;
    if (!wrap) return;
    wrap.empty();
    this.meterCanvases = [];
    const active = this.plugin.activeRecording;
    if (isRecording && active) {
      // ソースごとに「ラベル＋メーター」を1行ずつ（system メーターも sysrec の RMS で表示）。
      for (const src of this.meterSourcesFor(active.source)) {
        const meter = wrap.createDiv({ cls: "rmr-meter" });
        meter.createDiv({
          cls: "rmr-meter-label",
          text: src === "system" ? "システム音" : "マイク",
        });
        const canvas = meter.createEl("canvas", { cls: "rmr-canvas" });
        this.meterCanvases.push({ source: src, canvas });
      }
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
        if (!input.checked) return;
        this.vSource = src;
        // 手動ミキサーはソースでフェーダー本数が変わるので再描画（非録音時のみ）。
        if (!locked) this.render();
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

  /** ラベル付きチェックボックス行の共通生成（Monitor / Auto gain）。 */
  private buildCheckboxRow(
    panel: HTMLElement,
    label: string,
    opts: {
      checked: boolean;
      disabled?: boolean;
      hint?: string;
      onChange: (checked: boolean) => void;
    }
  ): void {
    const control = this.addRow(panel, label);
    const cb = control.createEl("input", { attr: { type: "checkbox" } });
    cb.checked = opts.checked;
    if (opts.disabled) cb.disabled = true;
    cb.addEventListener("change", () => opts.onChange(cb.checked));
    if (opts.hint) control.createSpan({ cls: "rmr-hint", text: opts.hint });
  }

  private buildMonitorRow(panel: HTMLElement): void {
    this.buildCheckboxRow(panel, "Monitor", {
      checked: this.vMonitor,
      hint: "入力を試聴（ヘッドホン推奨）",
      onChange: (checked) => {
        this.vMonitor = checked;
        this.plugin.setMonitor(checked); // 録音中でも表示専用タップに即反映
      },
    });
  }

  private buildStaticRow(panel: HTMLElement, label: string, value: string): void {
    this.addRow(panel, label, "rmr-static").setText(value);
  }

  /**
   * レベル調整の行群。「手動ミキサー」トグル（Manual モード＝AGC 置き換え）と、
   * Manual 時はソース別フェーダー、Auto 時は Auto gain チェックを出す。
   * モード切替は録音中ロック。フェーダーは Monitor と同じく録音中もライブ変更可。
   */
  private buildLevelRows(panel: HTMLElement, locked: boolean): void {
    const active = this.plugin.activeRecording;
    const isManual = active ? active.manualMix : this.vManualMix;

    this.buildCheckboxRow(panel, "手動ミキサー", {
      checked: isManual,
      disabled: locked,
      hint: "システム音とマイクを個別に手動調整（Auto gain は無効）",
      onChange: (checked) => {
        this.vManualMix = checked;
        this.render();
      },
    });

    if (isManual) {
      const src = active ? active.source : this.vSource;
      if (src !== "mic") {
        this.buildFaderRow(panel, "システム音", this.vSystemGainDb, (db) => {
          this.vSystemGainDb = db;
          this.plugin.setSystemGain(db); // 録音中でもライブ反映
        });
      }
      if (src !== "system") {
        this.buildFaderRow(panel, "マイク", this.vMicGainDb, (db) => {
          this.vMicGainDb = db;
          this.plugin.setMicGain(db);
        });
      }
    } else {
      this.buildCheckboxRow(panel, "Auto gain", {
        checked: active ? active.agc === "on" : this.vAgc,
        disabled: locked,
        onChange: (checked) => (this.vAgc = checked),
      });
    }
  }

  /** dB フェーダー行（-24〜+24dB）。録音中もロックせずライブ変更。 */
  private buildFaderRow(
    panel: HTMLElement,
    label: string,
    valueDb: number,
    onChange: (db: number) => void
  ): void {
    const control = this.addRow(panel, label, "rmr-fader-control");
    const range = control.createEl("input", {
      cls: "rmr-fader",
      attr: { type: "range", min: "-24", max: "24", step: "1" },
    });
    range.value = String(valueDb);
    const val = control.createSpan({ cls: "rmr-fader-val", text: fmtDb(valueDb) });
    range.addEventListener("input", () => {
      const db = Number(range.value);
      val.setText(fmtDb(db));
      onChange(db);
    });
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
        manualMix: this.vManualMix,
        systemGainDb: this.vSystemGainDb,
        micGainDb: this.vMicGainDb,
        embedNotePath: this.vEmbedFile?.path,
      });
    } catch (e) {
      new Notice(`録音を開始できませんでした: ${(e as Error).message}`);
      this.render();
      return;
    }
    // 先に録音状態で再描画（canvas を生成）してからメーターを繋ぐ（タップはプラグインが起動）
    this.render();
    if (this.plugin.activeRecording) {
      this.startWaveform();
    }
  }

  private async onStop(): Promise<void> {
    if (!this.recording) return;
    this.stopWaveform();
    await this.plugin.stopActiveRecording();
    this.render();
  }

  /** 各ソースのメーターに、plugin.getSourceLevels() のソース別レベルを流して描く。 */
  private startWaveform(): void {
    this.stopWaveform();
    for (const { source, canvas } of this.meterCanvases) {
      const r = new WaveformRenderer(canvas, () =>
        source === "system"
          ? this.plugin.getSourceLevels().system
          : this.plugin.getSourceLevels().mic
      );
      r.start();
      this.waveforms.push(r);
    }
  }

  private stopWaveform(): void {
    for (const r of this.waveforms) r.stop();
    this.waveforms = [];
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

/** ゲイン(dB)の表示（+付き・0dB も明示）。 */
function fmtDb(db: number): string {
  return `${db > 0 ? "+" : ""}${db} dB`;
}
