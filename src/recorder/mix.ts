import { spawn } from "child_process";
import * as fs from "fs";
import type { RecorderContext } from "../context";
import type { RecorderSource, TerminalEvent } from "../types";
import { sessionPaths } from "../state/paths";
import { readSessionMeta, finalizeCleanup } from "../state/sessionStore";
import { existsWithSize, intermediatePaths, statBytes } from "../util/fsx";

/**
 * オフライン mix。`caffeinate -i` で包んで実行し、終了コード + 出力ファイルで成否判定。
 * `mixed` イベントは status-file に出ない癖があるため、イベントはパースしない（設計書 §4.3）。
 */
export function runMix(
  ctx: RecorderContext,
  bin: string,
  sys: string,
  mic: string,
  out: string,
  agc: "on" | "off"
): Promise<boolean> {
  return new Promise((resolve) => {
    // 出力チャンネル数（1=モノラル / 2=ステレオ）。会議は L≒R になりがちなので既定はモノラル寄り。
    const channels = ctx.settings.channels === 1 ? "1" : "2";
    const args = [
      "-i",
      bin,
      "mix",
      "--in",
      sys,
      "--in",
      mic,
      "--out",
      out,
      "--agc",
      agc,
      "--channels",
      channels,
      // 出力ビットレート算出用（サンプルレートを下げると mix 出力も小さくなる）。
      "--samplerate",
      String(ctx.settings.sampleRate),
    ];
    let child;
    try {
      child = spawn("caffeinate", args, { stdio: "ignore" });
    } catch {
      resolve(false);
      return;
    }
    child.on("error", () => resolve(false));
    child.on("exit", (code) => {
      resolve(code === 0 && existsWithSize(out));
    });
  });
}

/**
 * 片方の中間ファイルだけ存在する場合、rename で最終ファイルに救う（設計書 §6-4）。
 * 両方 or 両方無しなら false（rename しない）。
 */
export function rescueRename(sys: string, mic: string, out: string): boolean {
  const sysE = existsWithSize(sys);
  const micE = existsWithSize(mic);
  if (sysE && !micE) {
    fs.renameSync(sys, out);
    return true;
  }
  if (micE && !sysE) {
    fs.renameSync(mic, out);
    return true;
  }
  return false;
}

/** 成功した最終ファイルから終端イベントを組み立てる。 */
function terminalStopped(
  event: "stopped" | "remixed",
  sessionId: string,
  out: string,
  source: RecorderSource
): TerminalEvent {
  return { event, sessionId, path: out, bytes: statBytes(out), source };
}

export interface RemixOptions {
  sessionId?: string;
  outPath?: string;
  agc?: "on" | "off";
}

/**
 * mix 失敗（stop-warning）や異常終了からの復旧。中間ファイル 2 つが残っていれば mix、
 * 片方だけなら rescue-rename。復旧できたらセッションを後始末する。
 * AGC 優先順位: 引数 → セッション JSON → "on"（設計書 §8.1）。
 */
export async function remix(ctx: RecorderContext, opts: RemixOptions): Promise<TerminalEvent> {
  const bin = ctx.resolveBinPath();
  const id = opts.sessionId ?? "";
  let out = opts.outPath;
  let source: RecorderSource = "both";
  let agc: "on" | "off" = "on";

  if (opts.sessionId) {
    const meta = readSessionMeta(sessionPaths(ctx.paths, opts.sessionId).json);
    if (!meta) {
      return { event: "remix-error", sessionId: id, message: "セッションが見つかりません" };
    }
    out = meta.out;
    source = meta.source;
    agc = meta.agc;
  }
  if (opts.agc) agc = opts.agc; // 引数優先

  if (!out) {
    return { event: "remix-error", sessionId: id, message: "出力パスが特定できません" };
  }
  if (!bin) {
    return { event: "remix-error", sessionId: id, message: "sysrec バイナリが見つかりません" };
  }

  const { sys, mic } = intermediatePaths(out);
  const sysE = existsWithSize(sys);
  const micE = existsWithSize(mic);

  if (sysE && micE) {
    const ok = await runMix(ctx, bin, sys, mic, out, agc);
    if (ok) {
      safeUnlink(sys);
      safeUnlink(mic);
      finalizeCleanup(ctx.paths, id);
      return terminalStopped("remixed", id, out, source);
    }
    return {
      event: "remix-error",
      sessionId: id,
      message: "mix に失敗しました（中間ファイルは保持しています）",
      parts: { system: sys, mic: mic },
    };
  }

  if (sysE || micE) {
    rescueRename(sys, mic, out);
    finalizeCleanup(ctx.paths, id);
    return terminalStopped("remixed", id, out, source);
  }

  return {
    event: "remix-error",
    sessionId: id,
    message: "中間ファイルがありません（復旧できません）",
  };
}

function safeUnlink(p: string): void {
  try {
    fs.unlinkSync(p);
  } catch {
    // 無視
  }
}

export { terminalStopped };
