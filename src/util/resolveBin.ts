import * as path from "path";
import { findOnPath, isExecutable, isFile } from "./pathProbe";

/** バイナリ解決の入力（context の一部を渡す・循環参照回避）。 */
export interface BinResolveInput {
  /** 設定で明示指定された絶対パス（空可） */
  binPath: string;
  /** プラグインディレクトリの絶対パス */
  pluginDir: string;
}

export type BinCandidateOrigin = "settings" | "native" | "bin" | "path";

export interface BinCandidate {
  origin: BinCandidateOrigin;
  path: string;
  exists: boolean;
  executable: boolean;
}

/**
 * 優先順位ごとの候補を列挙（doctor / Detect 表示用）。
 * 優先: settings.binPath → <pluginDir>/native/sysrec/sysrec → <pluginDir>/bin/sysrec → PATH "sysrec"
 */
export function binCandidates(input: BinResolveInput): BinCandidate[] {
  const list: { origin: BinCandidateOrigin; path: string }[] = [];
  if (input.binPath?.trim()) {
    list.push({ origin: "settings", path: input.binPath.trim() });
  }
  list.push({ origin: "native", path: path.join(input.pluginDir, "native", "sysrec", "sysrec") });
  list.push({ origin: "bin", path: path.join(input.pluginDir, "bin", "sysrec") });
  const onPath = findOnPath(["sysrec"]);
  if (onPath) list.push({ origin: "path", path: onPath });

  return list.map((c) => ({
    origin: c.origin,
    path: c.path,
    exists: isFile(c.path),
    executable: isFile(c.path) && isExecutable(c.path),
  }));
}

/**
 * spawn 対象のバイナリパスを解決。最初に存在する候補を返す。
 * どれも無ければ空文字（＝未検出。doctor で NG 表示）。
 */
export function resolveBinPath(input: BinResolveInput): string {
  const found = binCandidates(input).find((c) => c.exists);
  return found ? found.path : "";
}
