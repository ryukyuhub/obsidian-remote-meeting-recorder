import { MarkdownView, Notice, Plugin, TFile, WorkspaceLeaf, normalizePath } from "obsidian";
import * as path from "path";
import { DEFAULT_SETTINGS, RMRSettingTab, type RMRSettings } from "./settings";
import { createContext, getVaultBasePath, type RecorderContext } from "./context";
import { DoctorModal } from "./ui/DoctorModal";
import { StatusBarController } from "./ui/statusBar";
import { RecordingView, RECORDING_VIEW_TYPE } from "./ui/RecordingView";
import type { RecorderSource, SessionMeta, StartOptions, TerminalEvent } from "./types";
import { startRecording, StartError } from "./recorder/start";
import { startWebRecording } from "./recorder/startWeb";
import type { WebRecorder } from "./recorder/webCapture";
import { stopRecording } from "./recorder/stop";
import { remix } from "./recorder/mix";
import { restoreInProgressSessions } from "./recorder/restore";
import { SessionWatcher } from "./recorder/watch";
import { insertEmbed, computeVaultRelative } from "./ui/embed";
import { listMicDevices, type MicDevice } from "./recorder/devices";
import { linkToDailyNote } from "./ui/dailyNote";
import { rotateLogs, readSessionMeta, finalizeCleanup } from "./state/sessionStore";
import { sessionPaths } from "./state/paths";
import { statBytes } from "./util/fsx";
import { WebAudioTap } from "./audio/webAudioTap";
import { ControlWindowManager } from "./ui/controlWindow";
import { runTranscription } from "./transcribe/runTranscription";
import { TranscribePicker } from "./ui/TranscribePicker";

// Notice 表示時間（ms）。長め＝内容を読ませたい警告 / エラー＝失敗通知。
const NOTICE_LONG_MS = 10000;
const NOTICE_ERROR_MS = 8000;

/** ビューが操作する前面録音の情報（primary）。 */
export interface ActiveRecordingInfo {
  sessionId: string;
  source: RecorderSource;
  agc: "on" | "off";
  startedAt: number;
  label?: string;
}

export interface StartFromViewInput {
  source: RecorderSource;
  saveDirDisplay: string;
  filename: string;
  agc: boolean;
  label?: string;
  micDevice?: string;
  monitor?: boolean;
  /** 埋め込み先ノートのパス（未指定なら停止時に埋め込みしない） */
  embedNotePath?: string;
}

export default class RemoteMeetingRecorderPlugin extends Plugin {
  declare settings: RMRSettings;
  statusBar!: StatusBarController;

  activeRecording: ActiveRecordingInfo | null = null;

  private watchers = new Map<string, SessionWatcher>();
  // Windows(win32) のレンダラ内録音インスタンス（sessionId → WebRecorder）。真実の源はメモリ側。
  private webRecorders = new Map<string, WebRecorder>();
  private embedTargets = new Map<string, TFile | null>();
  private handledTerminals = new Set<string>();
  private recordingView: RecordingView | null = null;
  private lastWarningSessionId: string | null = null;
  private finalizedCallbacks: Array<(ev: TerminalEvent) => void> = [];

  // マイクの表示専用タップ（録音ビュー・ミニ窓の両方が参照する一元所有・§3.4）
  private micTap: WebAudioTap | null = null;
  private controlWindow: ControlWindowManager | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.registerView(RECORDING_VIEW_TYPE, (leaf) => new RecordingView(leaf, this));
    this.addSettingTab(new RMRSettingTab(this.app, this));

    const statusEl = this.addStatusBarItem();
    this.statusBar = new StatusBarController(statusEl);
    this.statusBar.setClickHandler(() => void this.openRecordingView());

    this.addRibbonIcon("circle-dot", "会議録音を開く", () => void this.openRecordingView());

    this.addCommand({
      id: "open-recording-view",
      name: "録音ビューを開く",
      callback: () => void this.openRecordingView(),
    });
    this.addCommand({
      id: "start-recording",
      name: "録音を開始（録音ビューを開く）",
      callback: () => void this.openRecordingView(),
    });
    this.addCommand({
      id: "stop-recording",
      name: "録音を停止",
      callback: () => void this.stopViaCommand(),
    });
    this.addCommand({
      id: "remix-last-failed",
      name: "失敗した録音を remix 復旧",
      callback: () => void this.remixLastFailed(),
    });
    this.addCommand({
      id: "transcribe-file",
      name: "録音ファイルを文字起こし",
      callback: () => new TranscribePicker(this).open(),
    });
    this.addCommand({
      id: "run-doctor",
      name: "診断を実行（doctor）",
      callback: () => new DoctorModal(this.app, this).open(),
    });

    // ノート（.md）右クリック → 「ここに会議録音を埋め込む」
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (!(file instanceof TFile) || file.extension !== "md") return;
        menu.addItem((item) =>
          item
            .setTitle("ここに会議録音を埋め込む")
            .setIcon("circle-dot")
            .onClick(() => void this.startRecordingHere(file))
        );
      })
    );

    // 起動時: 孤児掃除 → セッション復元（設計書 §7）
    this.app.workspace.onLayoutReady(() => this.restoreSessions());
  }

  onunload(): void {
    // macOS: 録音は殺さない。watcher の interval を止めるだけ（設計書 §6-7）。
    for (const w of this.watchers.values()) w.stop();
    this.watchers.clear();
    // Windows: レンダラ内録音はプラグイン unload で生かし続けられない。graceful に停止して
    // ファイルを確定する（best-effort。逐次追記済みなので最悪でも直近まで残る）。
    for (const rec of this.webRecorders.values()) {
      try {
        void rec.stop();
      } catch {
        /* noop */
      }
    }
    this.webRecorders.clear();
    // ミニ窓は残すとゾンビ化するので確実に破棄（表示専用・録音には非影響）
    this.controlWindow?.destroy();
    this.controlWindow = null;
    this.stopMicTap();
  }

  // ================================================================
  // 設定・コンテキスト
  // ================================================================
  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  getPluginDir(): string {
    const base = getVaultBasePath(this.app);
    if (this.manifest.dir) {
      return base ? path.join(base, this.manifest.dir) : this.manifest.dir;
    }
    const rel = path.join(this.app.vault.configDir, "plugins", this.manifest.id);
    return base ? path.join(base, rel) : rel;
  }

  buildContext(): RecorderContext {
    return createContext(this.app, this.settings, this.getPluginDir());
  }

  // ================================================================
  // 録音ビュー
  // ================================================================
  registerRecordingView(view: RecordingView): void {
    this.recordingView = view;
  }
  unregisterRecordingView(view: RecordingView): void {
    if (this.recordingView === view) this.recordingView = null;
  }

  async openRecordingView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(RECORDING_VIEW_TYPE);
    if (existing.length > 0) {
      this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf: WorkspaceLeaf | null = this.app.workspace.getLeaf(true);
    await leaf.setViewState({ type: RECORDING_VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  /** ノート右クリック「ここに会議録音を埋め込む」から: 録音ビューを開き、そのノートを埋め込み先にする。 */
  async startRecordingHere(file: TFile): Promise<void> {
    // 明示的な「ここに録音」なので停止時埋め込みを有効化しておく（未選択扱いを避ける）
    if (!this.settings.insertEmbedOnStop) {
      this.settings.insertEmbedOnStop = true;
      await this.saveSettings();
    }
    await this.openRecordingView();
    this.recordingView?.setEmbedTarget(file);
  }

  // ================================================================
  // 開始・停止（オーケストレーション）
  // ================================================================
  async startRecordingFromView(input: StartFromViewInput): Promise<void> {
    const ctx = this.buildContext();
    const saveDir = this.resolveSaveDir(input.saveDirDisplay);
    const opts: StartOptions = {
      source: input.source,
      saveDir,
      filename: input.filename,
      agc: input.agc,
      label: input.label,
      micDevice: input.micDevice || this.settings.inputDeviceUid || undefined,
    };

    // 埋め込み先ノートを開始時にキャプチャ（設計書 §9.4）。
    // 明示的に選択されたノートのみ対象。未選択（解決失敗も含む）なら null＝停止時に埋め込みしない。
    let startFile: TFile | null = null;
    if (input.embedNotePath) {
      const f = this.app.vault.getAbstractFileByPath(input.embedNotePath);
      if (f instanceof TFile) startFile = f;
    }

    let result;
    try {
      if (process.platform === "win32") {
        // Windows: 外部バイナリを使わずレンダラ内 Web Audio で録音する（Windows対応 実装計画）。
        const r = await startWebRecording(ctx, opts, (id) => this.onWebTerminated(id));
        this.webRecorders.set(r.sessionId, r.recorder);
        result = r;
      } else {
        result = await startRecording(ctx, opts);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const tail = e instanceof StartError && e.logTail ? `\n---\n${e.logTail}` : "";
      new Notice(`録音を開始できませんでした:\n${msg}${tail}`, NOTICE_LONG_MS);
      throw e;
    }

    this.embedTargets.set(result.sessionId, startFile);
    const meta = result.meta; // 永続化された正の meta（startedAt 一貫）
    this.activeRecording = {
      sessionId: meta.id,
      source: meta.source,
      agc: meta.agc,
      startedAt: meta.startedAt,
      label: meta.label,
    };
    this.startWatcher(meta);
    // Windows は WebRecorder 自身がマイクを取得済みで表示用レベルも出せるため、別タップを開かない
    // （同一マイクの二重 getUserMedia を避ける）。macOS は従来どおり表示専用タップを使う。
    if (meta.source !== "system" && process.platform !== "win32") {
      this.startMicTap(opts.micDevice, input.monitor ?? this.settings.monitor);
    }
    this.maybeOpenControlWindow();
    new Notice(`録音を開始しました（${input.source}）`);
  }

  // ================================================================
  // マイク表示専用タップ（録音ビュー・ミニ窓が参照）
  // ================================================================
  private startMicTap(deviceId: string | undefined, monitor: boolean): void {
    this.stopMicTap();
    const tap = new WebAudioTap();
    this.micTap = tap;
    void tap.start(deviceId || undefined, monitor).catch((e) => {
      new Notice(`マイクメーターを開始できませんでした（録音は継続）: ${(e as Error).message}`);
      if (this.micTap === tap) this.micTap = null;
    });
  }

  private stopMicTap(): void {
    this.micTap?.stop();
    this.micTap = null;
  }

  /** 現在の入力レベル（0..1・表示専用）。録音ビュー/ミニ窓が読む。 */
  getMicLevel(): number {
    // Windows は録音中の WebRecorder からレベルを読む（マイクを別途開かない）。
    const id = this.activeRecording?.sessionId;
    if (id) {
      const rec = this.webRecorders.get(id);
      if (rec) return rec.getLevel();
    }
    return this.micTap?.getLevel() ?? 0;
  }

  /** モニター（試聴）オン/オフをタップに反映。 */
  setMonitor(on: boolean): void {
    this.micTap?.setMonitor(on);
  }

  private startWatcher(meta: SessionMeta): void {
    const ctx = this.buildContext();
    const watcher = new SessionWatcher(
      ctx,
      meta,
      (elapsed) => this.onTick(meta.id, elapsed),
      (ev) => this.handleTerminal(ev, meta.id)
    );
    this.watchers.set(meta.id, watcher);
    watcher.start();
  }

  private onTick(sessionId: string, elapsedSec: number): void {
    if (this.activeRecording?.sessionId !== sessionId) return;
    this.recordingView?.setElapsed(elapsedSec);
    this.controlWindow?.tick(elapsedSec);
  }

  async stopActiveRecording(): Promise<void> {
    if (!this.activeRecording) return;
    await this.stopSession(this.activeRecording.sessionId);
  }

  private async stopViaCommand(): Promise<void> {
    if (!this.activeRecording && this.watchers.size === 0) {
      new Notice("録音中のセッションはありません。");
      return;
    }
    const id = this.activeRecording?.sessionId ?? this.watchers.keys().next().value;
    if (id) await this.stopSession(id);
  }

  private async stopSession(id: string): Promise<void> {
    // watcher を止めてから明示停止（二重 finalize/通知を防ぐ・finalize は冪等）
    this.watchers.get(id)?.stop();
    this.watchers.delete(id);
    const ctx = this.buildContext();
    const meta = readSessionMeta(sessionPaths(ctx.paths, id).json);
    const ev =
      meta?.platform === "win32"
        ? await this.stopWebSession(id)
        : await stopRecording(ctx, id);
    this.handleTerminal(ev, id);
  }

  /** Windows(win32) セッションの停止・finalize。WebRecorder を止めてファイルサイズで成否判定。冪等。 */
  private async stopWebSession(id: string): Promise<TerminalEvent> {
    const rec = this.webRecorders.get(id);
    this.webRecorders.delete(id);
    const ctx = this.buildContext();
    const meta = readSessionMeta(sessionPaths(ctx.paths, id).json);
    if (rec) {
      try {
        await rec.stop();
      } catch {
        // 停止時の例外は握る（ファイルが残っていれば救う）
      }
    }
    const out = meta?.out;
    const bytes = out ? statBytes(out) : 0;
    const durationSec = meta ? Math.round((Date.now() - meta.startedAt) / 1000) : undefined;
    finalizeCleanup(ctx.paths, id); // json/pid/status を後始末（音声ファイル out は残す）
    if (out && bytes > 0) {
      return { event: "stopped", sessionId: id, source: meta?.source, path: out, bytes, durationSec };
    }
    return {
      event: "stop-warning",
      sessionId: id,
      source: meta?.source,
      message:
        "録音データがありませんでした（マイクの許可、またはシステム音声の共有を確認してください）。",
    };
  }

  /** WebRecorder が予期せず終了（トラック切断・録音エラー）したときの合流点。明示停止と冪等。 */
  private onWebTerminated(id: string): void {
    if (this.handledTerminals.has(id) || !this.webRecorders.has(id)) return;
    void this.stopWebSession(id).then((ev) => this.handleTerminal(ev, id));
  }

  // ================================================================
  // 終端イベント処理（明示停止・外部停止の合流点）
  // ================================================================
  private handleTerminal(ev: TerminalEvent, sessionId: string): void {
    if (this.handledTerminals.has(sessionId)) return;
    this.handledTerminals.add(sessionId);

    this.watchers.get(sessionId)?.stop();
    this.watchers.delete(sessionId);

    const wasActive = this.activeRecording?.sessionId === sessionId;
    if (wasActive) {
      this.activeRecording = null;
      this.stopMicTap();
      this.controlWindow?.close();
    }

    switch (ev.event) {
      case "stopped":
      case "remixed": {
        if (wasActive) this.statusBar.clear();
        new Notice(
          `録音を保存しました${ev.durationSec ? `（${ev.durationSec}秒）` : ""}`
        );
        // 埋め込み先ノートは maybeInsertEmbed が消費するので先に控える（文字起こしの追記先）
        const embedTarget = this.embedTargets.get(sessionId) ?? null;
        void this.maybeInsertEmbed(ev, sessionId);
        this.emitFinalized(ev); // 外部フック点（設計書 §13）
        if (this.settings.transcribeOnStop && ev.path) {
          void runTranscription(this, ev.path, embedTarget); // Phase 6 一括文字起こし
        }
        break;
      }
      case "stop-warning":
        this.lastWarningSessionId = sessionId;
        if (wasActive) this.statusBar.setWarning();
        new Notice(
          `⚠ ${ev.message ?? "mix に失敗しました"}\n「失敗した録音を remix 復旧」で復旧できます。`,
          NOTICE_LONG_MS
        );
        break;
      case "remix-error":
        this.lastWarningSessionId = sessionId;
        new Notice(`⚠ remix に失敗しました: ${ev.message ?? ""}`, NOTICE_LONG_MS);
        break;
      case "stop-error":
        new Notice(`停止に失敗しました: ${ev.message ?? ""}`, NOTICE_ERROR_MS);
        break;
      case "start-error":
        new Notice(`起動に失敗しました: ${ev.message ?? ""}`, NOTICE_ERROR_MS);
        break;
    }

    this.recordingView?.onTerminal();
    // 復旧完了したら handled をクリア（次の同一 id 再利用は無いが念のため保持しない）
    if (ev.event === "remixed") this.handledTerminals.delete(sessionId);
  }

  private async maybeInsertEmbed(ev: TerminalEvent, sessionId: string): Promise<void> {
    const target = this.embedTargets.get(sessionId) ?? null;
    this.embedTargets.delete(sessionId);
    if (!ev.path || !this.settings.saveInVault) return;
    // 埋め込み先が明示的に選択されているときだけ埋め込む（未選択なら何もしない）
    if (this.settings.insertEmbedOnStop && target) {
      await insertEmbed(this.app, target, ev.path);
    }
    if (this.settings.linkToDailyNote) {
      const rel = computeVaultRelative(this.app, ev.path);
      if (rel) await linkToDailyNote(this.app, rel);
    }
  }

  // ================================================================
  // 文字起こし等のフック点 / デバイス列挙
  // ================================================================
  /** 録音が最終化（stopped/remixed）したら呼ばれるコールバックを登録。unregister を返す。 */
  onRecordingFinalized(cb: (ev: TerminalEvent) => void): () => void {
    this.finalizedCallbacks.push(cb);
    return () => {
      this.finalizedCallbacks = this.finalizedCallbacks.filter((c) => c !== cb);
    };
  }

  private emitFinalized(ev: TerminalEvent): void {
    for (const cb of this.finalizedCallbacks) {
      try {
        cb(ev);
      } catch (e) {
        console.error("[remote-meeting-recorder] onRecordingFinalized コールバック失敗", e);
      }
    }
  }

  /** マイク入力デバイス一覧（sysrec list-devices）。 */
  async listMicDevices(): Promise<MicDevice[]> {
    return listMicDevices(this.buildContext().resolveBinPath());
  }

  /** 既存の録音ファイルを手動で文字起こし（アクティブノートがあればそこへ追記）。 */
  async transcribeFile(audioPath: string): Promise<void> {
    const target = this.app.workspace.getActiveViewOfType(MarkdownView)?.file ?? null;
    await runTranscription(this, audioPath, target);
  }

  // ================================================================
  // 常時前面ミニ制御ウィンドウ（§9.4・§14.3）
  // ================================================================
  private maybeOpenControlWindow(): void {
    if (!this.settings.enableControlWindow || !this.activeRecording) return;
    if (!this.controlWindow) this.controlWindow = new ControlWindowManager();
    const accent =
      getComputedStyle(document.body).getPropertyValue("--interactive-accent").trim() || "#7c6cf0";
    const ok = this.controlWindow.open(
      {
        source: this.activeRecording.source,
        accent,
        label: this.activeRecording.label ?? "録音中",
      },
      () => void this.stopActiveRecording(),
      () => this.getMicLevel()
    );
    if (!ok) new Notice("ミニ制御ウィンドウを開けませんでした（この環境では未対応）。");
  }

  // ================================================================
  // remix 復旧
  // ================================================================
  async remixLastFailed(): Promise<void> {
    const id = this.lastWarningSessionId;
    if (!id) {
      new Notice("復旧対象の録音が見つかりません。");
      return;
    }
    new Notice("remix を実行中…");
    const ctx = this.buildContext();
    // handled 済みでも remix はやり直せるよう解除
    this.handledTerminals.delete(id);
    const ev = await remix(ctx, { sessionId: id });
    if (ev.event === "remixed") this.lastWarningSessionId = null;
    this.handleTerminal(ev, id);
  }

  // ================================================================
  // 復元
  // ================================================================
  private restoreSessions(): void {
    const ctx = this.buildContext();
    rotateLogs(ctx.paths); // 30 日より古い退避ログを掃除（設計書 §6-6）
    let result;
    try {
      result = restoreInProgressSessions(ctx);
    } catch (e) {
      console.error("[remote-meeting-recorder] restore 失敗", e);
      return;
    }

    for (const meta of result.active) {
      if (!this.activeRecording) {
        this.activeRecording = {
          sessionId: meta.id,
          source: meta.source,
          agc: meta.agc,
          startedAt: meta.startedAt,
          label: meta.label,
        };
      }
      this.startWatcher(meta);
    }
    if (result.active.length > 0) {
      new Notice(`録音中のセッションを ${result.active.length} 件復元しました。`);
    }
    // primary の表示専用タップ・ミニ窓も復帰（reload をまたいでも操作できるように）
    if (this.activeRecording) {
      if (this.activeRecording.source !== "system") {
        this.startMicTap(this.settings.inputDeviceUid || undefined, this.settings.monitor);
      }
      this.maybeOpenControlWindow();
    }

    for (const meta of result.needsRemix) {
      this.lastWarningSessionId = meta.id;
    }
    if (result.needsRemix.length > 0) {
      new Notice(
        `⚠ 前回異常終了した録音が ${result.needsRemix.length} 件あります。` +
          `「失敗した録音を remix 復旧」で復旧できます。`,
        10000
      );
    }

    // Windows のレンダラ内録音は再起動をまたげない。中断分は部分ファイルが保存済み。
    if (result.interruptedWeb.length > 0) {
      new Notice(
        `前回中断された録音が ${result.interruptedWeb.length} 件ありました（部分ファイルは保存済みです）。`,
        8000
      );
    }

    this.recordingView?.refresh();
  }

  // ================================================================
  // ヘルパー
  // ================================================================
  resolveSaveDir(display: string): string {
    const value = (display || this.settings.defaultSaveDir || "Recordings").trim();
    if (this.settings.saveInVault) {
      const base = getVaultBasePath(this.app) ?? "";
      return path.join(base, normalizePath(value));
    }
    return value;
  }
}
