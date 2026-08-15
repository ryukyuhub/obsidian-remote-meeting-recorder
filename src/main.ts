import {
  Editor,
  MarkdownFileInfo,
  MarkdownView,
  Menu,
  Notice,
  Plugin,
  TFile,
  WorkspaceLeaf,
  normalizePath,
} from "obsidian";
import * as path from "path";
import { DEFAULT_SETTINGS, RMRSettingTab, type RMRSettings } from "./settings";
import { createContext, getVaultBasePath, type RecorderContext } from "./context";
import { DoctorModal } from "./ui/DoctorModal";
import { StatusBarController } from "./ui/statusBar";
import { RecordingView, RECORDING_VIEW_TYPE } from "./ui/RecordingView";
import type {
  PendingRecovery,
  RecorderSource,
  SessionMeta,
  StartOptions,
  TerminalEvent,
} from "./types";
import { StartError, type StartResult } from "./recorder/start";
import { createRecorderBackend, type RecorderBackend } from "./recorder/backend";
import { remix } from "./recorder/mix";
import { restoreInProgressSessions, toPendingRecovery } from "./recorder/restore";
import { describePendingRecovery, pickPendingRecovery } from "./ui/RecoveryPicker";
import { SessionWatcher } from "./recorder/watch";
import { insertEmbed, computeVaultRelative } from "./ui/embed";
import type { MicDevice } from "./recorder/devices";
import { linkToDailyNote } from "./ui/dailyNote";
import { readSessionMeta, rotateLogs } from "./state/sessionStore";
import { sessionPaths } from "./state/paths";
import { ControlWindowManager } from "./ui/controlWindow";
import { runTranscription } from "./transcribe/runTranscription";
import { transcribeFile, transcribeAudioFile, transcribeEmbed } from "./transcribe/orchestrate";
import { isAudioFile } from "./transcribe/audioFormats";
import { TranscribePicker } from "./ui/TranscribePicker";

// Notice 表示時間（ms）。長め＝内容を読ませたい警告 / エラー＝失敗通知。
const NOTICE_LONG_MS = 10000;
const NOTICE_ERROR_MS = 8000;

/** ビューが操作する前面録音の情報（primary）。 */
export interface ActiveRecordingInfo {
  sessionId: string;
  source: RecorderSource;
  agc: "on" | "off";
  manualMix: boolean;
  startedAt: number;
  label?: string;
}

/** セッションメタから前面録音情報を組み立てる（起動時・復元時で共通）。 */
function toActiveRecordingInfo(meta: SessionMeta): ActiveRecordingInfo {
  return {
    sessionId: meta.id,
    source: meta.source,
    agc: meta.agc,
    manualMix: !!meta.manualMix,
    startedAt: meta.startedAt,
    label: meta.label,
  };
}

/** 行から音声埋め込み `![[linktext]]` の linktext（`|`/`#` より前）を取り出す。無ければ null。 */
function extractEmbedLinktext(line: string): string | null {
  const m = line.match(/!\[\[([^\]|#]+)/);
  return m ? m[1].trim() : null;
}

export interface StartFromViewInput {
  source: RecorderSource;
  saveDirDisplay: string;
  filename: string;
  agc: boolean;
  label?: string;
  micDevice?: string;
  monitor?: boolean;
  /** 手動ミキサー（Manual モード）と初期ゲイン(dB) */
  manualMix?: boolean;
  systemGainDb?: number;
  micGainDb?: number;
  /** 埋め込み先ノートのパス（未指定なら停止時に埋め込みしない） */
  embedNotePath?: string;
}

export default class RemoteMeetingRecorderPlugin extends Plugin {
  declare settings: RMRSettings;
  statusBar!: StatusBarController;

  activeRecording: ActiveRecordingInfo | null = null;

  private watchers = new Map<string, SessionWatcher>();
  private embedTargets = new Map<string, TFile | null>();
  private handledTerminals = new Set<string>();
  // 開いている録音ビュー（split 等で複数あり得るので Set で全件に通知する）
  private recordingViews = new Set<RecordingView>();
  // 復旧待ち（保存が完了しなかった録音）。単一スロットだと 2 件目以降が
  // UI から永久に辿れなくなるため全件保持する（Issue #6）。
  private pendingRecoveries: PendingRecovery[] = [];
  private finalizedCallbacks: Array<(ev: TerminalEvent) => void> = [];

  // 録音バックエンド（macOS=sysrec / Windows=WebRecorder）。platform 分岐はここに集約（§R3）。
  private backend!: RecorderBackend;
  private controlWindow: ControlWindowManager | null = null;
  // 手動ミキサー: 現在のソース別ゲイン(dB)。適用はバックエンドに委譲。
  private mixerGain = { systemDb: 0, micDb: 0 };

  async onload(): Promise<void> {
    await this.loadSettings();

    this.backend = createRecorderBackend({
      getCtx: () => this.buildContext(),
      notify: (message) => new Notice(message, NOTICE_LONG_MS),
      onTerminal: (ev, id) => this.handleTerminal(ev, id),
    });

    this.registerView(RECORDING_VIEW_TYPE, (leaf) => new RecordingView(leaf, this));
    this.addSettingTab(new RMRSettingTab(this.app, this));

    const statusEl = this.addStatusBarItem();
    this.statusBar = new StatusBarController(statusEl);
    this.statusBar.setClickHandler(() => void this.openRecordingView());

    this.addRibbonIcon("circle-dot", "会議録音を開く", () => void this.openRecordingView());

    this.registerCommands();
    this.registerFileMenu();
    this.registerEmbedTranscribeMenus();

    // 起動時: 孤児掃除 → セッション復元（設計書 §7）
    this.app.workspace.onLayoutReady(() => this.restoreSessions());
  }

  /** コマンドパレットのコマンドを登録。 */
  private registerCommands(): void {
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
      // id は既存ホットキー互換のため据え置き（表示名だけ平易にした）。
      id: "remix-last-failed",
      name: "保存が完了しなかった録音を復旧",
      callback: () => void this.recoverRecording(),
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
  }

  /**
   * ファイルエクスプローラの右クリック。
   * .md → 「ここに会議録音を埋め込む」／音声ファイル → 「文字起こし（RMR）」。
   */
  private registerFileMenu(): void {
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (!(file instanceof TFile)) return;
        if (file.extension === "md") {
          menu.addItem((item) =>
            item
              .setTitle("ここに会議録音を埋め込む")
              .setIcon("circle-dot")
              .onClick(() => void this.startRecordingHere(file))
          );
          return;
        }
        if (isAudioFile(file)) {
          menu.addItem((item) =>
            item
              .setTitle("文字起こし（RMR）")
              .setIcon("captions")
              .onClick(() => void this.transcribeAudioFile(file))
          );
        }
      })
    );
  }

  /**
   * ノート内の埋め込み音声 `![[...]]` の右クリックに「文字起こし（RMR）」を出す。
   * ソース/ライブプレビューのテキスト上は editor-menu、描画された音声プレイヤーは
   * DOM の contextmenu（Chromium 既定の音声メニューを差し替え）で拾う。
   */
  private registerEmbedTranscribeMenus(): void {
    // ソース表示で `![[audio]]` 行を右クリック
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor: Editor, info: MarkdownFileInfo) => {
        const line = editor.getCursor().line;
        const linktext = extractEmbedLinktext(editor.getLine(line));
        if (!linktext) return;
        const note = info.file ?? this.app.workspace.getActiveViewOfType(MarkdownView)?.file ?? null;
        const audio = this.app.metadataCache.getFirstLinkpathDest(linktext, note?.path ?? "");
        if (!(audio instanceof TFile) || !isAudioFile(audio)) return;
        menu.addItem((item) =>
          item
            .setTitle("文字起こし（RMR）")
            .setIcon("captions")
            .onClick(() => void this.transcribeEmbed(audio, note, line))
        );
      })
    );

    // 描画された音声埋め込みを右クリック（閲覧ビュー・ライブプレビュー）
    this.registerDomEvent(activeDocument, "contextmenu", (evt) => {
      const target = evt.target as HTMLElement | null;
      const embed = target?.closest?.(".internal-embed") as HTMLElement | null;
      const src = embed?.getAttribute("src");
      if (!src) return;
      const mdView = this.app.workspace.getActiveViewOfType(MarkdownView);
      const audio = this.app.metadataCache.getFirstLinkpathDest(src, mdView?.file?.path ?? "");
      if (!(audio instanceof TFile) || !isAudioFile(audio)) return;
      evt.preventDefault();
      const menu = new Menu();
      menu.addItem((item) =>
        item
          .setTitle("文字起こし（RMR）")
          .setIcon("captions")
          .onClick(() => void this.transcribeEmbed(audio, mdView?.file ?? null, undefined, src))
      );
      menu.showAtMouseEvent(evt);
    });
  }

  onunload(): void {
    // macOS: 録音は殺さない。watcher の interval を止めるだけ（設計書 §6-7）。
    for (const w of this.watchers.values()) w.stop();
    this.watchers.clear();
    // バックエンドの後始末（macOS=表示系のみ / Windows=graceful 停止でファイル確定）。
    this.backend.dispose();
    // ミニ窓は残すとゾンビ化するので確実に破棄（表示専用・録音には非影響）
    this.controlWindow?.destroy();
    this.controlWindow = null;
  }

  // ================================================================
  // 設定・コンテキスト
  // ================================================================
  async loadSettings(): Promise<void> {
    this.settings = Object.assign(
      {},
      DEFAULT_SETTINGS,
      (await this.loadData()) as Partial<RMRSettings> | null
    );
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    // 設定画面と録音ビューの双方向同期: どこで変えても録音ビューに即反映する。
    for (const v of this.recordingViews) v.refresh();
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
    return createContext(this.app, this.settings, this.getPluginDir(), this.manifest.version);
  }

  // ================================================================
  // 録音ビュー
  // ================================================================
  registerRecordingView(view: RecordingView): void {
    this.recordingViews.add(view);
  }
  unregisterRecordingView(view: RecordingView): void {
    this.recordingViews.delete(view);
  }

  async openRecordingView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(RECORDING_VIEW_TYPE);
    if (existing.length > 0) {
      await this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf: WorkspaceLeaf | null = this.app.workspace.getLeaf(true);
    await leaf.setViewState({ type: RECORDING_VIEW_TYPE, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }

  /** ノート右クリック「ここに会議録音を埋め込む」から: 録音ビューを開き、そのノートを埋め込み先にする。 */
  async startRecordingHere(file: TFile): Promise<void> {
    // 明示的な「ここに録音」なので停止時埋め込みを有効化しておく（未選択扱いを避ける）
    if (!this.settings.insertEmbedOnStop) {
      this.settings.insertEmbedOnStop = true;
      await this.saveSettings();
    }
    await this.openRecordingView();
    for (const v of this.recordingViews) v.setEmbedTarget(file);
  }

  // ================================================================
  // 開始・停止（オーケストレーション）
  // ================================================================
  async startRecordingFromView(input: StartFromViewInput): Promise<void> {
    const saveDir = this.resolveSaveDir(input.saveDirDisplay);
    const opts: StartOptions = {
      source: input.source,
      saveDir,
      filename: input.filename,
      agc: input.agc,
      label: input.label,
      micDevice: input.micDevice || this.settings.inputDeviceUid || undefined,
      manualMix: input.manualMix,
      systemGainDb: input.systemGainDb,
      micGainDb: input.micGainDb,
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
      result = await this.backend.start(opts);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const tail = e instanceof StartError && e.logTail ? `\n---\n${e.logTail}` : "";
      new Notice(`録音を開始できませんでした:\n${msg}${tail}`, NOTICE_LONG_MS);
      throw e;
    }

    this.activateSession(result, startFile, opts, input.monitor ?? this.settings.monitor);
    new Notice(`録音を開始しました（${input.source}）`);
  }

  /** 起動成功後のアクティブ化: 埋め込み先控え・状態設定・watcher/マイクタップ/ミニ窓の起動。 */
  private activateSession(
    result: StartResult,
    startFile: TFile | null,
    opts: StartOptions,
    monitor: boolean
  ): void {
    this.embedTargets.set(result.sessionId, startFile);
    const meta = result.meta; // 永続化された正の meta（startedAt 一貫）
    this.activeRecording = toActiveRecordingInfo(meta);
    this.startWatcher(meta);
    // 手動ミキサー: 初期ゲインを控える。適用・メーター・無音ウォッチはバックエンドが担う。
    this.mixerGain = { systemDb: opts.systemGainDb ?? 0, micDb: opts.micGainDb ?? 0 };
    this.backend.attachSession(meta, { micDevice: opts.micDevice, monitor });
    this.maybeOpenControlWindow();
  }

  /** 現在の入力レベル（0..1・表示専用）。録音ビュー/ミニ窓が読む。 */
  getMicLevel(): number {
    return this.backend.micLevel(this.activeRecording?.sessionId ?? null);
  }

  /** 録音中のソース別レベル（0..1）。system/mic の 2 メーター用。 */
  getSourceLevels(): { system: number; mic: number } {
    return this.backend.sourceLevels(this.activeRecording?.sessionId ?? null);
  }

  /** モニター（試聴）オン/オフを反映。 */
  setMonitor(on: boolean): void {
    this.backend.setMonitor(on);
  }

  /** 手動ミキサー: システム音のゲイン(dB)を録音中にライブ変更する。 */
  setSystemGain(db: number): void {
    this.mixerGain.systemDb = db;
    this.applyMixerGains();
  }

  /** 手動ミキサー: マイクのゲイン(dB)を録音中にライブ変更する。 */
  setMicGain(db: number): void {
    this.mixerGain.micDb = db;
    this.applyMixerGains();
  }

  /** 現在のミキサーゲイン(dB)をライブ適用する。 */
  private applyMixerGains(): void {
    this.backend.applyGains(
      this.activeRecording?.sessionId ?? null,
      this.mixerGain.systemDb,
      this.mixerGain.micDb
    );
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
    for (const v of this.recordingViews) v.setElapsed(elapsedSec);
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
    const ev = await this.backend.stop(id);
    this.handleTerminal(ev, id);
  }

  // ================================================================
  // 終端イベント処理（明示停止・外部停止の合流点）
  // ================================================================
  private handleTerminal(ev: TerminalEvent, sessionId: string): void {
    if (this.handledTerminals.has(sessionId)) return;
    this.handledTerminals.add(sessionId);

    // meta は watcher を捨てる前に控える（復旧待ちの表示情報を組み立てるのに要る）。
    const watcher = this.watchers.get(sessionId);
    const meta = watcher?.meta ?? null;
    watcher?.stop();
    this.watchers.delete(sessionId);

    const wasActive = this.activeRecording?.sessionId === sessionId;
    if (wasActive) {
      this.activeRecording = null;
      this.backend.detachSession();
      this.controlWindow?.close();
    }

    switch (ev.event) {
      case "stopped":
      case "remixed":
        this.removePendingRecovery(sessionId);
        this.finalizeSaved(ev, sessionId);
        break;
      case "stop-warning":
        if (ev.recoverable === false) {
          // 素材が無いので復旧のしようがない。原因だけ伝えて警告は残さない。
          new Notice(`⚠ ${ev.message ?? "録音を保存できませんでした"}`, NOTICE_LONG_MS);
        } else {
          // 音声は中間ファイルに残っている。用語ではなく「何が起きて何ができるか」を伝える。
          this.addPendingRecovery(sessionId, meta);
          this.notifyRecoveryNeeded(
            "録音の保存が最後まで終わりませんでした。音声は残っているので復旧できます。"
          );
        }
        break;
      case "remix-error":
        if (ev.recoverable === false) this.removePendingRecovery(sessionId);
        else this.addPendingRecovery(sessionId, meta);
        new Notice(`⚠ 復旧できませんでした: ${ev.message ?? ""}`, NOTICE_LONG_MS);
        break;
      case "stop-error":
        new Notice(`停止に失敗しました: ${ev.message ?? ""}`, NOTICE_ERROR_MS);
        break;
      case "start-error":
        new Notice(`起動に失敗しました: ${ev.message ?? ""}`, NOTICE_ERROR_MS);
        break;
    }

    for (const v of this.recordingViews) v.onTerminal();
    // 復旧完了したら handled をクリア（次の同一 id 再利用は無いが念のため保持しない）
    if (ev.event === "remixed") this.handledTerminals.delete(sessionId);
  }

  /** 保存成功（stopped/remixed）: 埋め込み・外部フック・自動文字起こし。 */
  private finalizeSaved(ev: TerminalEvent, sessionId: string): void {
    new Notice(`録音を保存しました${ev.durationSec ? `（${ev.durationSec}秒）` : ""}`);
    // 埋め込み先ノートは maybeInsertEmbed が消費するので先に控える（文字起こしの追記先）
    const embedTarget = this.embedTargets.get(sessionId) ?? null;
    void this.maybeInsertEmbed(ev, sessionId);
    this.emitFinalized(ev); // 外部フック点（設計書 §13）
    if (this.settings.transcribeOnStop && ev.path) {
      void runTranscription(this, ev.path, embedTarget); // Phase 6 一括文字起こし
    }
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

  /** マイク入力デバイス一覧（macOS=sysrec list-devices / Windows=enumerateDevices）。 */
  async listMicDevices(): Promise<MicDevice[]> {
    return this.backend.listMicDevices();
  }

  // ================================================================
  // 文字起こし（実体は transcribe/orchestrate.ts・ここは UI からの入口の委譲のみ）
  // ================================================================
  /** 既存の録音ファイルを手動で文字起こし。 */
  async transcribeFile(audioPath: string): Promise<void> {
    await transcribeFile(this, audioPath);
  }

  /** ファイルエクスプローラの音声ファイルを文字起こし。 */
  async transcribeAudioFile(file: TFile): Promise<void> {
    await transcribeAudioFile(this, file);
  }

  /** 埋め込み音声の文字起こし（結果は埋め込み直下へ挿入）。 */
  async transcribeEmbed(
    audio: TFile,
    note: TFile | null,
    anchorLine?: number,
    srcHint?: string
  ): Promise<void> {
    await transcribeEmbed(this, audio, note, anchorLine, srcHint);
  }

  // ================================================================
  // 常時前面ミニ制御ウィンドウ（§9.4・§14.3）
  // ================================================================
  /** ミニ制御ウィンドウ設定の変更を即時反映する（録音中ならその場で開閉）。 */
  applyControlWindowSetting(): void {
    if (this.settings.enableControlWindow) {
      this.maybeOpenControlWindow();
    } else {
      this.controlWindow?.close();
    }
  }

  private maybeOpenControlWindow(): void {
    if (!this.settings.enableControlWindow || !this.activeRecording) return;
    if (!this.controlWindow) this.controlWindow = new ControlWindowManager();
    const accent =
      getComputedStyle(activeDocument.body).getPropertyValue("--interactive-accent").trim() ||
      "#7c6cf0";
    const ok = this.controlWindow.open(
      {
        source: this.activeRecording.source,
        accent,
        label: this.activeRecording.label ?? "録音中",
        manual: this.activeRecording.manualMix,
        systemGainDb: this.mixerGain.systemDb,
        micGainDb: this.mixerGain.micDb,
      },
      () => void this.stopActiveRecording(),
      () => this.getSourceLevels(),
      (which, db) => (which === "system" ? this.setSystemGain(db) : this.setMicGain(db))
    );
    if (!ok) new Notice("ミニ制御ウィンドウを開けませんでした（この環境では未対応）。");
  }

  // ================================================================
  // 復旧（保存が完了しなかった録音の mix やり直し）
  // ================================================================
  /** 録音ビュー・ステータスバーが読む復旧待ち一覧。 */
  getPendingRecoveries(): readonly PendingRecovery[] {
    return this.pendingRecoveries;
  }

  /** 復旧待ちに追加（同一セッションは上書き）。表示情報は meta から組み立てる。 */
  private addPendingRecovery(sessionId: string, meta: SessionMeta | null): void {
    const ctx = this.buildContext();
    const resolved = meta ?? readSessionMeta(sessionPaths(ctx.paths, sessionId).json);
    if (!resolved) return;
    this.pendingRecoveries = this.pendingRecoveries.filter((p) => p.sessionId !== sessionId);
    this.pendingRecoveries.push(toPendingRecovery(ctx, resolved));
    this.refreshRecoveryUi();
  }

  private removePendingRecovery(sessionId: string): void {
    const before = this.pendingRecoveries.length;
    this.pendingRecoveries = this.pendingRecoveries.filter((p) => p.sessionId !== sessionId);
    if (this.pendingRecoveries.length !== before) this.refreshRecoveryUi();
  }

  /** ステータスバーと録音ビューへ復旧待ちの件数を反映。 */
  private refreshRecoveryUi(): void {
    if (this.pendingRecoveries.length > 0) {
      this.statusBar.setWarning(this.pendingRecoveries.length);
    } else {
      this.statusBar.clear();
    }
    for (const v of this.recordingViews) v.refresh();
  }

  /**
   * 復旧を促す Notice。コマンド名を覚えていなくても押すだけで復旧できるよう
   * ボタンを埋め込む（Issue #6）。対象がどの録音かも明示する。
   */
  private notifyRecoveryNeeded(message: string): void {
    const pending = [...this.pendingRecoveries];
    const notice = new Notice(
      createFragment((frag) => {
        frag.createDiv({ text: `⚠ ${message}` });
        for (const p of pending) {
          frag.createDiv({ cls: "rmr-notice-item", text: describePendingRecovery(p) });
        }
        const btn = frag.createEl("button", { cls: "rmr-notice-action", text: "録音を復旧する" });
        btn.addEventListener("click", () => {
          notice.hide();
          void this.recoverRecording();
        });
      }),
      NOTICE_LONG_MS
    );
  }

  /**
   * 保存が完了しなかった録音を復旧する（中間ファイルから mix をやり直す）。
   * sessionId 省略時は、1 件なら即実行・複数ならどれを復旧するか選ばせる。
   */
  async recoverRecording(sessionId?: string): Promise<void> {
    if (this.pendingRecoveries.length === 0) {
      new Notice("復旧が必要な録音はありません。");
      return;
    }
    let target = sessionId
      ? this.pendingRecoveries.find((p) => p.sessionId === sessionId)
      : this.pendingRecoveries.length === 1
        ? this.pendingRecoveries[0]
        : ((await pickPendingRecovery(this.app, [...this.pendingRecoveries])) ?? undefined);
    if (!target) return;

    new Notice(`復旧しています…（${describePendingRecovery(target)}）`);
    const ctx = this.buildContext();
    // handled 済みでも復旧はやり直せるよう解除
    this.handledTerminals.delete(target.sessionId);
    const ev = await remix(ctx, { sessionId: target.sessionId });
    this.handleTerminal(ev, target.sessionId);
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

    let primaryMeta: SessionMeta | null = null;
    for (const meta of result.active) {
      if (!this.activeRecording) {
        this.activeRecording = toActiveRecordingInfo(meta);
        primaryMeta = meta;
      }
      this.startWatcher(meta);
    }
    if (result.active.length > 0) {
      new Notice(`録音中のセッションを ${result.active.length} 件復元しました。`);
    }
    // primary の付帯機能（メーター・ミニ窓）も復帰（reload をまたいでも操作できるように）
    if (primaryMeta) {
      this.backend.attachSession(primaryMeta, {
        micDevice: this.settings.inputDeviceUid || undefined,
        monitor: this.settings.monitor,
      });
      this.maybeOpenControlWindow();
    }

    // 復旧待ちは全件保持する（1 件だけ覚えると 2 件目以降が UI から辿れない）。
    for (const meta of result.needsRemix) {
      this.addPendingRecovery(meta.id, meta);
    }
    if (result.needsRemix.length > 0) {
      this.notifyRecoveryNeeded(
        `前回、保存が最後まで終わらなかった録音が ${result.needsRemix.length} 件あります。` +
          "音声は残っているので復旧できます。"
      );
    }

    // Windows のレンダラ内録音は再起動をまたげない。中断分は部分ファイルが保存済み。
    if (result.interruptedWeb.length > 0) {
      new Notice(
        `前回中断された録音が ${result.interruptedWeb.length} 件ありました（部分ファイルは保存済みです）。`,
        8000
      );
    }

    for (const v of this.recordingViews) v.refresh();
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
