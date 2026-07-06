import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { safeUnlink } from "../util/fsx";

export interface TranscribeOptions {
  /** 進捗（0..100）。whisper の -pp 出力を解析して呼ぶ。 */
  onProgress?: (percent: number) => void;
  /** キャンセル用シグナル。abort されたら whisper 子プロセスを kill して中断する。 */
  signal?: AbortSignal;
}

/** ユーザーが明示的に中止したことを表す（呼び出し側でエラー扱いしないための番兵）。 */
export class TranscribeCancelled extends Error {
  constructor() {
    super("文字起こしをキャンセルしました");
    this.name = "TranscribeCancelled";
  }
}

// 文字起こし全体のタイムアウト（長尺音声＋CPU 推論を見込んで 1 時間）。
const TRANSCRIBE_TIMEOUT_MS = 3_600_000;

/**
 * whisper.cpp CLI で 16kHz mono WAV を文字起こしし、プレーンテキストを返す。
 * -nt でタイムスタンプ無し、-otxt/-of で <outBase>.txt に出力し読み取る。
 *
 * 速度・体感対策:
 *   - `-t`（スレッド数）を CPU コア数に合わせて上げる（既定 4 より速い）。
 *   - `-pp`（進捗）を stderr に出し、ストリーム解析して onProgress で通知（「止まって見える」対策）。
 *
 * Windows 対策: whisper.cpp はモデル/入力をナロー文字列でファイル I/O するため、
 * パスに非 ASCII（例: 日本語の「マイドライブ」）が含まれると開けず失敗する。
 * cwd をモデルのディレクトリにして -m はベース名（ASCII）で渡すことで回避する
 * （wav/-of は ASCII の一時ディレクトリなので絶対パスのままでよい）。
 */
export async function transcribeWav(
  bin: string,
  model: string,
  wavPath: string,
  language: string,
  outBase: string,
  opts: TranscribeOptions = {}
): Promise<string> {
  const win = process.platform === "win32";
  const modelArg = win ? path.basename(model) : model;
  const cwd = win ? path.dirname(model) : undefined;
  const threads = Math.max(1, Math.min(8, os.cpus().length || 4));
  const args = [
    "-m", modelArg,
    "-f", wavPath,
    "-l", language || "auto",
    "-t", String(threads),
    "-pp", // 進捗を stderr に出す
    "-nt", // タイムスタンプ無し
    "-otxt",
    "-of", outBase,
  ];

  await runWhisper(bin, args, cwd, opts.onProgress, opts.signal);

  const txtPath = `${outBase}.txt`;
  let text = "";
  try {
    text = fs.readFileSync(txtPath, "utf8");
  } finally {
    safeUnlink(txtPath);
  }
  return text.trim();
}

/** whisper-cli を spawn し、stderr から進捗を拾いつつ完了を待つ。失敗時は末尾ログ付きで reject。 */
function runWhisper(
  bin: string,
  args: string[],
  cwd: string | undefined,
  onProgress?: (percent: number) => void,
  signal?: AbortSignal
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new TranscribeCancelled());
      return;
    }
    const child = spawn(bin, args, cwd ? { cwd } : {});
    let log = "";
    let lastPct = -1;
    let settled = false;

    // タイムアウト・abort・close/error のどれで終わっても後始末を一度だけ行う。
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      if (onAbort) signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = signal
      ? () => {
          try {
            child.kill();
          } catch {
            /* noop */
          }
          finish(() => reject(new TranscribeCancelled()));
        }
      : undefined;
    if (onAbort) signal?.addEventListener("abort", onAbort);

    const onData = (buf: Buffer) => {
      const text = buf.toString();
      log += text;
      if (log.length > 1 << 20) log = log.slice(-(1 << 19)); // 直近だけ保持
      if (onProgress) {
        const matches = text.match(/progress\s*=\s*(\d+)\s*%/g);
        if (matches) {
          const pct = parseInt(matches[matches.length - 1].replace(/\D/g, ""), 10);
          if (Number.isFinite(pct) && pct !== lastPct) {
            lastPct = pct;
            onProgress(pct);
          }
        }
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);

    const timer = window.setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* noop */
      }
      finish(() => reject(new Error("文字起こしがタイムアウトしました（1時間）。")));
    }, TRANSCRIBE_TIMEOUT_MS);

    child.on("error", (e) => finish(() => reject(e)));
    child.on("close", (code) => {
      finish(() =>
        code === 0
          ? resolve()
          : reject(new Error(`whisper-cli が失敗しました (exit ${code})\n${log.slice(-2000)}`))
      );
    });
  });
}
