import type { RecorderContext } from "../context";
import type { TerminalEvent } from "../types";
import { readSessionMeta, finalizeCleanup } from "../state/sessionStore";
import { sessionPaths } from "../state/paths";
import { statBytes } from "../util/fsx";
import { savedTerminalEvent } from "./mix";
import type { WebRecorder } from "./webCapture";

/**
 * Windows(win32) セッションの停止・finalize（darwin の stop.ts に対応する Web 版）。
 * WebRecorder を止めてファイルサイズで成否を判定する。音声ファイル(out)は逐次追記済みなので
 * 停止時に例外が出ても残っていれば救う。json/pid/status のみ後始末する（out は残す）。冪等前提。
 */
export async function stopWebRecording(
  ctx: RecorderContext,
  id: string,
  rec: WebRecorder | undefined
): Promise<TerminalEvent> {
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
    return savedTerminalEvent("stopped", id, meta?.source, out, durationSec);
  }
  return {
    event: "stop-warning",
    sessionId: id,
    source: meta?.source,
    message:
      "録音データがありませんでした（マイクの許可、またはシステム音声の共有を確認してください）。",
  };
}
