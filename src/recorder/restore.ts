import * as path from "path";
import type { RecorderContext } from "../context";
import type { PendingRecovery, SessionMeta } from "../types";
import { listSessions, finalizeCleanup } from "../state/sessionStore";
import { sessionPaths } from "../state/paths";
import { isAlive } from "./spawn";
import { parseDurationSec } from "./stop";
import { sweepOrphans, hasSalvageableIntermediate } from "./sweep";

export interface RestoreResult {
  /** 生存中 — SessionWatcher + status bar を復元する対象 */
  active: SessionMeta[];
  /** 死亡かつ中間ファイルあり — 「異常終了・Remix 実行を」Notice の対象 */
  needsRemix: SessionMeta[];
  /** Windows のレンダラ内録音で中断されたもの — 部分ファイルは保存済み・状態のみ後始末 */
  interruptedWeb: SessionMeta[];
}

/**
 * 起動時のセッション再発見（設計書 §7）。
 * sweepOrphans で掃除後、残ったセッションを「生存＝復元」「死亡＋中間＝要 remix」に分類する。
 * （死亡かつ中間なしは sweep 済みなので残らない）
 * Windows(win32) の録音はレンダラ内で走るため Obsidian 再起動をまたげない。
 * 起動時に残っている win32 セッションは中断分として扱い、部分ファイル(meta.out)は残して状態のみ後始末する。
 */
export function restoreInProgressSessions(ctx: RecorderContext): RestoreResult {
  sweepOrphans(ctx);

  const active: SessionMeta[] = [];
  const needsRemix: SessionMeta[] = [];
  const interruptedWeb: SessionMeta[] = [];
  for (const meta of listSessions(ctx.paths)) {
    if (meta.platform === "win32") {
      finalizeCleanup(ctx.paths, meta.id);
      interruptedWeb.push(meta);
      continue;
    }
    if (isAlive(meta.pid)) {
      active.push(meta);
    } else if (hasSalvageableIntermediate(meta)) {
      needsRemix.push(meta);
    }
  }
  return { active, needsRemix, interruptedWeb };
}

/**
 * 復旧待ち録音の表示情報を組み立てる（どの録音かを利用者に示すため・Issue #6）。
 * 長さは status ファイルの stopped 行から拾う（無ければ省略）。
 */
export function toPendingRecovery(ctx: RecorderContext, meta: SessionMeta): PendingRecovery {
  return {
    sessionId: meta.id,
    label: meta.label ?? path.basename(meta.out, path.extname(meta.out)),
    startedAt: meta.startedAt,
    durationSec: parseDurationSec(sessionPaths(ctx.paths, meta.id).status),
  };
}
