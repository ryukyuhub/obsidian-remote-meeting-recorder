import type { RecorderContext } from "../context";
import type { SessionMeta } from "../types";
import { listSessions, archiveLog, deleteSessionFiles } from "../state/sessionStore";
import { isAlive } from "./spawn";
import { existsWithSize, intermediatePaths } from "../util/fsx";

/**
 * 孤児セッションを掃除（設計書 §5.2・§6-2）。
 * - pid 生存 → 温存
 * - pid 死亡かつ both の中間ファイルが残る → remix 待ちとして温存（消すと録音喪失）
 * - それ以外（死亡・中間なし）→ ログ退避後に削除
 */
export function sweepOrphans(ctx: RecorderContext): void {
  for (const meta of listSessions(ctx.paths)) {
    if (isAlive(meta.pid)) continue;
    if (hasSalvageableIntermediate(meta)) continue;
    archiveLog(ctx.paths, meta.id);
    deleteSessionFiles(ctx.paths, meta.id);
  }
}

/** both で中間ファイルのどちらかが残っているか（＝remix で救える）。 */
export function hasSalvageableIntermediate(meta: SessionMeta): boolean {
  if (meta.source !== "both") return false;
  const { sys, mic } = intermediatePaths(meta.out);
  return existsWithSize(sys) || existsWithSize(mic);
}
