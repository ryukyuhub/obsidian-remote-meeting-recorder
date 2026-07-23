import * as fs from "fs";
import type { RecorderContext } from "../context";
import type { SessionMeta, TerminalEvent } from "../types";
import { sessionPaths } from "../state/paths";
import { readSessionMeta, finalizeCleanup } from "../state/sessionStore";
import { isAlive } from "./spawn";
import { mixOrRescue, normalizeFile, savedTerminalEvent } from "./mix";
import { delay } from "../util/delay";
import { existsWithSize, safeUnlink } from "../util/fsx";

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
    const outcome = await mixOrRescue(ctx, meta.bin, meta.out, meta.agc, meta.id);
    switch (outcome.kind) {
      case "mixed":
      case "rescued":
        return savedTerminalEvent("stopped", meta.id, meta.source, meta.out, durationSec);
      case "mix-failed":
        // 中間+json+log を温存 / pid+status+control+level のみ rm → stop-warning（remix で復旧可）
        safeUnlink(sp.pid);
        safeUnlink(sp.status);
        safeUnlink(sp.control);
        safeUnlink(sp.level);
        return {
          event: "stop-warning",
          sessionId: meta.id,
          source: "both",
          message: "mix に失敗しました。remix で復旧できます（中間ファイルは保持）。",
          parts: { system: outcome.sys, mic: outcome.mic },
        };
      case "no-data":
        finalizeCleanup(ctx.paths, meta.id);
        return {
          event: "stop-warning",
          sessionId: meta.id,
          source: "both",
          message: "録音データがありません（マイク権限やデバイスを確認してください）。",
        };
    }
  }

  // single
  if (existsWithSize(meta.out)) {
    // single は mix を通らない＝正規化されない。AGC も無い（AutoGain オフ・手動ミキサー）と
    // どこにもゲイン補正が掛からず生レベルのまま出るので、ここで仕上げる（Issue #4）。
    // 失敗しても元ファイルは無傷なのでそのまま stopped を返す。
    if (meta.agc === "off") await normalizeFile(meta.bin, meta.out);
    finalizeCleanup(ctx.paths, meta.id);
    return savedTerminalEvent("stopped", meta.id, meta.source, meta.out, durationSec);
  }
  finalizeCleanup(ctx.paths, meta.id);
  return {
    event: "stop-warning",
    sessionId: meta.id,
    source: meta.source,
    message: "録音ファイルが生成されませんでした。",
  };
}
