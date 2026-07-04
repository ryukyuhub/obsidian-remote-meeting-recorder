import * as fs from "fs";
import * as path from "path";
import type { SessionMeta } from "../types";
import { sessionPaths, type StatePaths } from "./paths";
import { atomicWriteFile, ensureDir } from "../util/fsx";

/** SID: rec_ + 時刻(36進) + ランダム4文字（設計書 §5.1）。 */
export function newSessionId(): string {
  return "rec_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/** セッションメタをアトミックに書き込む（半端な JSON を残さない・設計書 §5.2）。 */
export function writeSessionMeta(paths: StatePaths, meta: SessionMeta): void {
  ensureDir(paths.sessionsDir);
  atomicWriteFile(sessionPaths(paths, meta.id).json, JSON.stringify(meta, null, 2));
}

/** セッションメタを読む。壊れた JSON は null（= corrupt 扱い → sweep 対象）。 */
export function readSessionMeta(jsonPath: string): SessionMeta | null {
  try {
    const obj = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
    if (!obj || typeof obj.id !== "string" || typeof obj.pid !== "number") return null;
    if (typeof obj.out !== "string" || typeof obj.source !== "string") return null;
    return obj as SessionMeta;
  } catch {
    return null;
  }
}

/** sessions/ 内の全メタを列挙（corrupt はスキップ）。 */
export function listSessions(paths: StatePaths): SessionMeta[] {
  let files: string[];
  try {
    files = fs.readdirSync(paths.sessionsDir);
  } catch {
    return [];
  }
  const out: SessionMeta[] = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    const meta = readSessionMeta(path.join(paths.sessionsDir, f));
    if (meta) out.push(meta);
  }
  return out;
}

/** json/pid/status を削除（log は archiveLog で退避するため残す）。 */
export function deleteSessionFiles(paths: StatePaths, id: string): void {
  const p = sessionPaths(paths, id);
  for (const f of [p.json, p.pid, p.status]) {
    try {
      fs.unlinkSync(f);
    } catch {
      // 無ければ無視
    }
  }
}

/** sessions/<id>.log → logs/<id>.log へ退避（原因究明用・消さない）。 */
export function archiveLog(paths: StatePaths, id: string): void {
  const p = sessionPaths(paths, id);
  try {
    if (fs.existsSync(p.log)) {
      ensureDir(paths.logsDir);
      fs.renameSync(p.log, p.archivedLog);
    }
  } catch {
    // 退避に失敗しても停止処理は続行
  }
}

/** 停止成功時の後始末: ログ退避 → ローテ → セッションファイル削除。 */
export function finalizeCleanup(paths: StatePaths, id: string): void {
  archiveLog(paths, id);
  rotateLogs(paths);
  deleteSessionFiles(paths, id);
}

/** logs/ で mtime が days 日より古いものを削除（find -mtime +30 -delete 相当）。 */
export function rotateLogs(paths: StatePaths, days = 30): void {
  let files: string[];
  try {
    files = fs.readdirSync(paths.logsDir);
  } catch {
    return;
  }
  const cutoff = Date.now() - days * 24 * 3600 * 1000;
  for (const f of files) {
    const fp = path.join(paths.logsDir, f);
    try {
      if (fs.statSync(fp).mtimeMs < cutoff) fs.unlinkSync(fp);
    } catch {
      // 無視
    }
  }
}
