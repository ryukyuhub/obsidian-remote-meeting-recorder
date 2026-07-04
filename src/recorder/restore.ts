import type { RecorderContext } from "../context";
import type { SessionMeta } from "../types";
import { listSessions } from "../state/sessionStore";
import { isAlive } from "./spawn";
import { sweepOrphans, hasSalvageableIntermediate } from "./sweep";

export interface RestoreResult {
  /** 生存中 — SessionWatcher + status bar を復元する対象 */
  active: SessionMeta[];
  /** 死亡かつ中間ファイルあり — 「異常終了・Remix 実行を」Notice の対象 */
  needsRemix: SessionMeta[];
}

/**
 * 起動時のセッション再発見（設計書 §7）。
 * sweepOrphans で掃除後、残ったセッションを「生存＝復元」「死亡＋中間＝要 remix」に分類する。
 * （死亡かつ中間なしは sweep 済みなので残らない）
 */
export function restoreInProgressSessions(ctx: RecorderContext): RestoreResult {
  sweepOrphans(ctx);

  const active: SessionMeta[] = [];
  const needsRemix: SessionMeta[] = [];
  for (const meta of listSessions(ctx.paths)) {
    if (isAlive(meta.pid)) {
      active.push(meta);
    } else if (hasSalvageableIntermediate(meta)) {
      needsRemix.push(meta);
    }
  }
  return { active, needsRemix };
}
