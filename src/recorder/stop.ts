import * as fs from "fs";
import type { RecorderContext } from "../context";
import type { SessionMeta, TerminalEvent } from "../types";
import { sessionPaths } from "../state/paths";
import { readSessionMeta, finalizeCleanup } from "../state/sessionStore";
import { isAlive } from "./spawn";
import { runMix, rescueRename } from "./mix";
import { delay } from "../util/delay";
import { existsWithSize, intermediatePaths, safeUnlink, statBytes } from "../util/fsx";

/** status ファイルに stopped イベントが現れたか（キーは sortedKeys でこの並び）。 */
export function statusHasStopped(statusPath: string): boolean {
  try {
    return /"event":"stopped"/.test(fs.readFileSync(statusPath, "utf8"));
  } catch {
    return false;
  }
}

/** stopped 行から durationSec を取り出す（表示用・失敗は致命でない）。 */
function parseDurationSec(statusPath: string): number | undefined {
  try {
    const lines = fs.readFileSync(statusPath, "utf8").trim().split(/\r?\n/).reverse();
    for (const line of lines) {
      if (line.includes('"event":"stopped"')) {
        const obj = JSON.parse(line);
        if (typeof obj.durationSec === "number") return obj.durationSec;
      }
    }
  } catch {
    // 無視
  }
  return undefined;
}

/**
 * 録音停止（設計書 §5.3）。SIGTERM → status の stopped or pid 死亡を
 * 0.1s×200(=20s) ポーリング → finalizeSession。
 */
export async function stopRecording(ctx: RecorderContext, id: string): Promise<TerminalEvent> {
  const sp = sessionPaths(ctx.paths, id);
  const meta = readSessionMeta(sp.json);
  if (!meta) {
    return { event: "stop-error", sessionId: id, message: "セッションが見つかりません" };
  }

  if (isAlive(meta.pid)) {
    try {
      process.kill(meta.pid, "SIGTERM");
    } catch {
      // 既に死亡していれば finalize へ
    }
  }

  for (let i = 0; i < 200; i++) {
    if (statusHasStopped(sp.status)) break;
    if (!isAlive(meta.pid)) break;
    await delay(100);
  }

  return finalizeSession(ctx, meta);
}

// 冪等化: 同一セッションの finalize は 1 回だけ実行し、同じ Promise を返す
// （stopRecording と watcher が同時に検出しても二重 mix しない・設計書 §7）
const inflight = new Map<string, Promise<TerminalEvent>>();

export function finalizeSession(ctx: RecorderContext, meta: SessionMeta): Promise<TerminalEvent> {
  const existing = inflight.get(meta.id);
  if (existing) return existing;
  const p = doFinalize(ctx, meta).finally(() => inflight.delete(meta.id));
  inflight.set(meta.id, p);
  return p;
}

async function doFinalize(ctx: RecorderContext, meta: SessionMeta): Promise<TerminalEvent> {
  const sp = sessionPaths(ctx.paths, meta.id);
  const durationSec = parseDurationSec(sp.status);

  if (meta.source === "both") {
    const { sys, mic } = intermediatePaths(meta.out);
    const sysE = existsWithSize(sys);
    const micE = existsWithSize(mic);

    if (sysE && micE) {
      const ok = await runMix(ctx, meta.bin, sys, mic, meta.out, meta.agc);
      if (ok) {
        safeUnlink(sys);
        safeUnlink(mic);
        finalizeCleanup(ctx.paths, meta.id);
        return stopped(meta, meta.out, durationSec);
      }
      // mix 失敗 → 中間+json+log を温存 / pid+status のみ rm → stop-warning（remix で復旧可）
      safeUnlink(sp.pid);
      safeUnlink(sp.status);
      return {
        event: "stop-warning",
        sessionId: meta.id,
        source: "both",
        message: "mix に失敗しました。remix で復旧できます（中間ファイルは保持）。",
        parts: { system: sys, mic: mic },
      };
    }

    if (sysE || micE) {
      // 片方だけ → rename で救う
      rescueRename(sys, mic, meta.out);
      finalizeCleanup(ctx.paths, meta.id);
      return stopped(meta, meta.out, durationSec);
    }

    // 両方無し = 録れていない
    finalizeCleanup(ctx.paths, meta.id);
    return {
      event: "stop-warning",
      sessionId: meta.id,
      source: "both",
      message: "録音データがありません（画面収録権限やデバイスを確認してください）。",
    };
  }

  // single
  if (existsWithSize(meta.out)) {
    finalizeCleanup(ctx.paths, meta.id);
    return stopped(meta, meta.out, durationSec);
  }
  finalizeCleanup(ctx.paths, meta.id);
  return {
    event: "stop-warning",
    sessionId: meta.id,
    source: meta.source,
    message: "録音ファイルが生成されませんでした。",
  };
}

function stopped(meta: SessionMeta, out: string, durationSec?: number): TerminalEvent {
  return {
    event: "stopped",
    sessionId: meta.id,
    source: meta.source,
    path: out,
    bytes: statBytes(out),
    durationSec,
  };
}
