// Windows(win32) 録音開始（Web Audio 経路・Windows対応 実装計画 §Phase W2）。
// darwin の startRecording（sysrec spawn）に対応するレンダラ内録音版。
// 順序: 保存先/拡張子解決 → WebRecorder.start（起動検証）→ 生存 OK のときだけ session JSON を書く。

import type { RecorderContext } from "../context";
import type { SessionMeta, StartOptions } from "../types";
import { newSessionId, writeSessionMeta } from "../state/sessionStore";
import { resolveOutPath, StartError, type StartResult } from "./start";
import { ensureDir } from "../util/fsx";
import { WebRecorder, pickAudioFormat } from "./webCapture";

export interface WebStartResult extends StartResult {
  recorder: WebRecorder;
}

/**
 * Windows 録音を開始する。onTerminated は「予期しない終了」（トラック切断・録音エラー）で
 * 生成した sessionId 付きで呼ばれる。呼び出し側（main.ts）は WebRecorder を保持すること。
 */
export async function startWebRecording(
  ctx: RecorderContext,
  o: StartOptions,
  onTerminated: (sessionId: string) => void,
  onSilence?: () => void
): Promise<WebStartResult> {
  ensureDir(o.saveDir);

  // mime を先に決めてから拡張子つきの out を確定（mp4/AAC 可なら .m4a、不可なら .webm）。
  const fmt = pickAudioFormat();
  const out = resolveOutPath(o.saveDir, o.filename, fmt.ext);

  const id = newSessionId();
  ensureDir(ctx.paths.sessionsDir);

  const recorder = new WebRecorder({
    out,
    source: o.source,
    micDevice: o.micDevice,
    mimeType: fmt.mimeType,
    sampleRate: o.sampleRate ?? ctx.settings.sampleRate,
    agc: o.agc,
    manualMix: o.manualMix,
    systemGainDb: o.systemGainDb,
    micGainDb: o.micGainDb,
    onTerminated: () => onTerminated(id),
    onSilence,
  });

  // 起動検証: 実際に録音が始まってから JSON を書く（半端な状態を残さない・設計書 §5.2 の思想を踏襲）。
  try {
    await recorder.start();
  } catch (e) {
    try {
      await recorder.stop();
    } catch {
      /* noop */
    }
    throw new StartError(`録音を開始できませんでした: ${(e as Error).message}`);
  }

  const meta: SessionMeta = {
    id,
    pid: process.pid, // 参考値。win32 では liveness 判定に使わない（watcher/restore が platform で分岐）。
    platform: "win32",
    source: o.source,
    agc: o.manualMix ? "off" : o.agc ? "on" : "off",
    manualMix: o.manualMix,
    out,
    bin: "",
    startedAt: Date.now(),
    label: o.label,
  };
  writeSessionMeta(ctx.paths, meta);

  return { sessionId: id, out, pid: meta.pid, meta, recorder };
}
