import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export interface TranscribeOptions {
  /** 進捗（0..100）。whisper の -pp 出力を解析して呼ぶ。 */
  onProgress?: (percent: number) => void;
}

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

  await runWhisper(bin, args, cwd, opts.onProgress);

  const txtPath = `${outBase}.txt`;
  let text = "";
  try {
    text = fs.readFileSync(txtPath, "utf8");
  } finally {
    try {
      fs.unlinkSync(txtPath);
    } catch {
      // 無視
    }
  }
  return text.trim();
}

/** whisper-cli を spawn し、stderr から進捗を拾いつつ完了を待つ。失敗時は末尾ログ付きで reject。 */
function runWhisper(
  bin: string,
  args: string[],
  cwd: string | undefined,
  onProgress?: (percent: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, cwd ? { cwd } : {});
    let log = "";
    let lastPct = -1;

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
      reject(new Error("文字起こしがタイムアウトしました（1時間）。"));
    }, 3_600_000);

    child.on("error", (e) => {
      window.clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      window.clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`whisper-cli が失敗しました (exit ${code})\n${log.slice(-2000)}`));
    });
  });
}
