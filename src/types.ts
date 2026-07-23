// 共有型定義（設計書 §5・§8.1）

/** 録音ソース。both = システム音声＋マイクを別録りして後段で mix。 */
export type RecorderSource = "both" | "system" | "mic";

/**
 * セッションメタ（真実の源＝ファイルシステム上の `<id>.json`）。
 * sysrec はレンダラより長生きするため、状態はメモリではなくここに置く。
 */
export interface SessionMeta {
  id: string;
  pid: number;
  /** darwin = sysrec 外部プロセス / win32 = レンダラ内 Web Audio 録音（WebRecorder） */
  platform: "darwin" | "win32";
  source: RecorderSource;
  agc: "on" | "off";
  /** 手動ミキサー（Manual モード）で録音したか。復元時の UI 表示（フェーダーの有無）に使う。 */
  manualMix?: boolean;
  /** both のときは中間ファイルの base（拡張子込みの最終 .m4a パス）。single は最終ファイル。 */
  out: string;
  bin: string;
  /** epoch ミリ秒（ローカル時計。elapsed 表示に使用） */
  startedAt: number;
  label?: string;
}

/** 録音開始オプション（RecordingView / StartModal が組み立てる）。 */
export interface StartOptions {
  source: RecorderSource;
  /** 保存先ディレクトリ（絶対パス） */
  saveDir: string;
  /** ファイル名（stem もしくは .m4a 付き。空なら既定 YYYY-MM-DD-HHMM） */
  filename: string;
  agc: boolean;
  micDevice?: string;
  label?: string;
  sampleRate?: number;
  channels?: number;
  /** 手動ミキサー（Manual モード）。true のとき AGC は使わず、ソース別の手動ゲインを適用する。 */
  manualMix?: boolean;
  /** 手動ミキサーの初期ゲイン（dB）。録音中は control ファイル経由でライブ更新する。 */
  systemGainDb?: number;
  micGainDb?: number;
}

/** 終端イベントの語彙（設計書 §5.4）。UI はこれを解釈して反応する。 */
export type TerminalEventKind =
  | "stopped"
  | "stop-warning"
  | "remixed"
  | "remix-error"
  | "start-error"
  | "stop-error";

export interface TerminalEvent {
  event: TerminalEventKind;
  sessionId: string;
  source?: RecorderSource;
  /** 最終 .m4a の絶対パス（成功時） */
  path?: string;
  durationSec?: number;
  bytes?: number;
  /** 警告・エラー時の説明（ログ tail 等） */
  message?: string;
  /** both の中間ファイル（stop-warning 時に温存されているもの） */
  parts?: { system?: string; mic?: string };
}
