// 録音バックエンド抽象（リファクタ調査 R3）。
//
// macOS（sysrec 外部バイナリ）と Windows（レンダラ内 Web Audio）は録音の実現方法が
// 根本的に違うが、main.ts から見た操作は同じ（開始/停止/レベル/ゲイン/後始末）。
// 以前は main.ts が process.platform 分岐を 6 箇所に持ち、「片方だけ実装し忘れる」
// 構造事故が実際に起きた（Issue #4: Windows に AGC が配線されていなかった）。
// 分岐を 1 枚のインターフェースに集約し、忘れたら型エラーになるようにする。
//
// 責務の線引き:
//   - バックエンド: 録音の開始/停止・録音中の付帯機能（メーター・無音ウォッチ・ゲイン適用）
//   - main.ts: セッションのオーケストレーション（watcher・終端イベント・埋め込み・UI）
import type { TerminalEvent, SessionMeta, StartOptions } from "../types";
import type { RecorderContext } from "../context";
import { startRecording, type StartResult } from "./start";
import { stopRecording } from "./stop";
import { startWebRecording } from "./startWeb";
import { stopWebRecording } from "./stopWeb";
import type { WebRecorder } from "./webCapture";
import { listMicDevices, type MicDevice } from "./devices";
import { listWebMicDevices } from "../audio/webDevices";
import { WebAudioTap } from "../audio/webAudioTap";
import { LevelPoller } from "./levelPoller";
import { sessionPaths } from "../state/paths";
import { atomicWriteFile } from "../util/fsx";

/** macOS 無音ウォッチ: 開始からこの時間レベル 0 のままなら警告（BT 立ち上がり猶予込み）。 */
const SILENCE_WATCH_MS = 10000;

export interface BackendDeps {
  /** 最新設定を反映したコンテキストを都度取得する（設定変更に追従するため関数で渡す）。 */
  getCtx: () => RecorderContext;
  /** ユーザー通知（Notice）。バックエンドを obsidian 非依存に保つため注入する。 */
  notify: (message: string) => void;
  /**
   * 予期しない終端の合流点（Windows のトラック切断など）。
   * main.ts の handleTerminal へ届ける。冪等が前提。
   */
  onTerminal: (ev: TerminalEvent, sessionId: string) => void;
}

/** 録音中の付帯機能（メーター等）の起動パラメータ。 */
export interface AttachOptions {
  micDevice?: string;
  monitor: boolean;
}

export interface RecorderBackend {
  /** 録音開始（起動検証込み）。失敗は throw（StartError を含む）。 */
  start(opts: StartOptions): Promise<StartResult>;
  /** セッション停止 → 終端イベント（冪等）。 */
  stop(id: string): Promise<TerminalEvent>;
  /** アクティブ化に伴う付帯機能の起動（表示メーター・無音ウォッチ）。 */
  attachSession(meta: SessionMeta, opts: AttachOptions): void;
  /** attachSession の対。アクティブ解除時・unload 時に呼ぶ。 */
  detachSession(): void;
  /** 録音中のソース別レベル（0..1・system/mic の 2 メーター用）。 */
  sourceLevels(activeId: string | null): { system: number; mic: number };
  /** 表示用マイクレベル（0..1）。 */
  micLevel(activeId: string | null): number;
  /** モニター（自分のマイク試聴）切替。対応しないバックエンドでは no-op。 */
  setMonitor(on: boolean): void;
  /** 手動ミキサーのゲイン(dB)をライブ適用。 */
  applyGains(activeId: string | null, systemGainDb: number, micGainDb: number): void;
  /** マイク入力デバイス一覧（設定・録音ビューのドロップダウン用）。 */
  listMicDevices(): Promise<MicDevice[]>;
  /** プラグイン unload 時の後始末。macOS は録音を殺さない（設計書 §6-7）。 */
  dispose(): void;
}

/** プラットフォームに応じたバックエンドを生成する（分岐はここ 1 箇所）。 */
export function createRecorderBackend(deps: BackendDeps): RecorderBackend {
  return process.platform === "win32" ? new Win32Backend(deps) : new DarwinBackend(deps);
}

// ====================================================================
// macOS: sysrec 外部バイナリ駆動。
// 録音の真実はファイルシステム（設計書 §3.2）。表示メーターはマイクの別タップと
// sysrec の level ファイルで賄い、ゲインは control ファイル経由でライブ適用する。
// ====================================================================
class DarwinBackend implements RecorderBackend {
  // マイクの表示専用タップ（録音ビュー・ミニ窓の両方が参照する一元所有・設計書 §3.4）
  private micTap: WebAudioTap | null = null;
  private levelPoller: LevelPoller | null = null;
  private silenceWatchTimer: number | null = null;
  private attachedId: string | null = null;

  constructor(private readonly deps: BackendDeps) {}

  start(opts: StartOptions): Promise<StartResult> {
    return startRecording(this.deps.getCtx(), opts);
  }

  stop(id: string): Promise<TerminalEvent> {
    return stopRecording(this.deps.getCtx(), id);
  }

  attachSession(meta: SessionMeta, opts: AttachOptions): void {
    this.detachSession();
    this.attachedId = meta.id;
    // 表示専用マイクタップ（source が mic を含むときだけ。録音物には影響しない）
    if (meta.source !== "system") {
      const tap = new WebAudioTap();
      this.micTap = tap;
      void tap.start(opts.micDevice || undefined, opts.monitor).catch((e) => {
        this.deps.notify(
          `マイクメーターを開始できませんでした（録音は継続）: ${(e as Error).message}`
        );
        if (this.micTap === tap) this.micTap = null;
      });
    }
    // sysrec の level ファイル（取り込み実測 RMS）のポーリング（Auto/Manual 両モード）
    const level = sessionPaths(this.deps.getCtx().paths, meta.id).level;
    this.levelPoller = new LevelPoller(level);
    this.levelPoller.start();
    this.startSilenceWatch(meta);
  }

  detachSession(): void {
    this.attachedId = null;
    this.micTap?.stop();
    this.micTap = null;
    this.levelPoller?.stop();
    this.levelPoller = null;
    if (this.silenceWatchTimer != null) {
      window.clearTimeout(this.silenceWatchTimer);
      this.silenceWatchTimer = null;
    }
  }

  /**
   * 無音ウォッチ（Windows は WebRecorder 内に同等の 5 秒ウォッチあり）。
   * 開始から 10 秒、録音対象ソースのレベルが 0 のままなら知らせる。
   * BT イヤホンの死に状態などで「録れているつもりが無音」だった実害（2026-07-24）への防御。
   */
  private startSilenceWatch(meta: SessionMeta): void {
    const checkSystem = meta.source !== "mic";
    const checkMic = meta.source !== "system";
    this.silenceWatchTimer = window.setTimeout(() => {
      this.silenceWatchTimer = null;
      if (this.attachedId !== meta.id) return; // 既に停止/別セッション
      const lv = this.levelPoller?.levels();
      if (!lv) return;
      const dead: string[] = [];
      if (checkSystem && lv.system <= 0) dead.push("システム音声");
      if (checkMic && lv.mic <= 0) dead.push("マイク");
      if (dead.length > 0) {
        this.deps.notify(
          `⚠ ${dead.join("と")}のレベルが 0 のままです。音声が取り込めていない可能性があります` +
            `（出力デバイスの接続状態・マイク権限・入力デバイスを確認してください）。録音自体は継続しています。`
        );
      }
    }, SILENCE_WATCH_MS);
  }

  sourceLevels(): { system: number; mic: number } {
    return this.levelPoller?.levels() ?? { system: 0, mic: 0 };
  }

  micLevel(): number {
    return this.micTap?.getLevel() ?? 0;
  }

  setMonitor(on: boolean): void {
    this.micTap?.setMonitor(on);
  }

  applyGains(activeId: string | null, systemGainDb: number, micGainDb: number): void {
    if (!activeId) return;
    // control ファイルへ書く（sysrec が polling してライブ適用）。書けなくても録音は継続。
    try {
      const control = sessionPaths(this.deps.getCtx().paths, activeId).control;
      atomicWriteFile(control, JSON.stringify({ systemGainDb, micGainDb }));
    } catch {
      /* noop */
    }
  }

  listMicDevices(): Promise<MicDevice[]> {
    return listMicDevices(this.deps.getCtx().resolveBinPath());
  }

  dispose(): void {
    // 録音（sysrec）は殺さない。表示系だけ畳む。
    this.detachSession();
  }
}

// ====================================================================
// Windows: レンダラ内 Web Audio 録音（WebRecorder）。
// 真実の源はメモリ側（webRecorders Map）。予期しない終了（トラック切断）は
// WebRecorder のコールバック → ここで stop に合流させて deps.onTerminal へ届ける。
// ====================================================================
class Win32Backend implements RecorderBackend {
  private webRecorders = new Map<string, WebRecorder>();

  constructor(private readonly deps: BackendDeps) {}

  async start(opts: StartOptions): Promise<StartResult> {
    const r = await startWebRecording(
      this.deps.getCtx(),
      opts,
      (id) => this.onUnexpectedEnd(id),
      () =>
        this.deps.notify(
          "録音レベルが 0 のままです。音声が取り込めていない可能性があります" +
            "（システム音声の共有・マイクの許可・入力デバイスを確認してください）。"
        )
    );
    this.webRecorders.set(r.sessionId, r.recorder);
    return r;
  }

  stop(id: string): Promise<TerminalEvent> {
    const rec = this.webRecorders.get(id);
    this.webRecorders.delete(id);
    return stopWebRecording(this.deps.getCtx(), id, rec);
  }

  /** WebRecorder が予期せず終了したときの合流点。明示停止（Map から除去済み）と冪等。 */
  private onUnexpectedEnd(id: string): void {
    if (!this.webRecorders.has(id)) return;
    void this.stop(id).then((ev) => this.deps.onTerminal(ev, id));
  }

  attachSession(): void {
    // WebRecorder 自身がマイクを取得済みで表示用レベルも出せるため、別タップは開かない
    // （同一マイクの二重 getUserMedia を避ける）。
  }

  detachSession(): void {
    /* noop */
  }

  sourceLevels(activeId: string | null): { system: number; mic: number } {
    const rec = activeId ? this.webRecorders.get(activeId) : undefined;
    return rec ? rec.getSourceLevels() : { system: 0, mic: 0 };
  }

  micLevel(activeId: string | null): number {
    const rec = activeId ? this.webRecorders.get(activeId) : undefined;
    return rec ? rec.getLevel() : 0;
  }

  setMonitor(): void {
    // Windows はモニター（試聴）未対応（表示タップを開かないため）。
  }

  applyGains(activeId: string | null, systemGainDb: number, micGainDb: number): void {
    const rec = activeId ? this.webRecorders.get(activeId) : undefined;
    if (!rec) return;
    rec.setSystemGain(systemGainDb);
    rec.setMicGain(micGainDb);
  }

  listMicDevices(): Promise<MicDevice[]> {
    return listWebMicDevices();
  }

  dispose(): void {
    // レンダラ内録音はプラグイン unload で生かし続けられない。graceful に停止して
    // ファイルを確定する（best-effort。逐次追記済みなので最悪でも直近まで残る）。
    for (const rec of this.webRecorders.values()) {
      try {
        void rec.stop();
      } catch {
        /* noop */
      }
    }
    this.webRecorders.clear();
  }
}
