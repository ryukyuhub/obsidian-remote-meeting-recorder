import * as os from "os";
import * as path from "path";
import type { RMRSettings } from "../settings";

/** 状態ディレクトリ配下のパス群（設計書 §5.1）。 */
export interface StatePaths {
  stateDir: string;
  sessionsDir: string;
  logsDir: string;
}

/** 単一セッションのファイル群パス。 */
export interface SessionFilePaths {
  json: string;
  pid: string;
  status: string;
  log: string;
  /** 停止時退避先（logs/<id>.log） */
  archivedLog: string;
}

/** stateDir を解決（設定で上書き可・既定は `$HOME/.meeting-recorder`）。 */
export function resolveStateDir(settings: RMRSettings): string {
  const custom = settings.stateDir?.trim();
  if (custom) return custom;
  return path.join(os.homedir(), ".meeting-recorder");
}

export function makePaths(settings: RMRSettings): StatePaths {
  const stateDir = resolveStateDir(settings);
  return {
    stateDir,
    sessionsDir: path.join(stateDir, "sessions"),
    logsDir: path.join(stateDir, "logs"),
  };
}

export function sessionPaths(paths: StatePaths, id: string): SessionFilePaths {
  return {
    json: path.join(paths.sessionsDir, `${id}.json`),
    pid: path.join(paths.sessionsDir, `${id}.pid`),
    status: path.join(paths.sessionsDir, `${id}.status`),
    log: path.join(paths.sessionsDir, `${id}.log`),
    archivedLog: path.join(paths.logsDir, `${id}.log`),
  };
}
