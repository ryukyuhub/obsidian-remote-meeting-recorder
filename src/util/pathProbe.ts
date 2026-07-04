import * as fs from "fs";
import * as path from "path";

/* バイナリ探索の共通処理（sysrec / whisper.cpp の解決で共用）。 */

/**
 * GUI アプリ（Obsidian）の process.env.PATH には含まれないことが多い、
 * Homebrew / MacPorts の標準 bin ディレクトリ。PATH 検索時に補完する。
 */
export const EXTRA_BIN_DIRS = ["/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin"];

/** 実行可能ファイルか（X_OK）。 */
export function isExecutable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** 通常ファイルとして存在するか。 */
export function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** PATH 検索対象ディレクトリ（環境の PATH ＋ Homebrew 等の補完・重複排除）。 */
export function pathSearchDirs(): string[] {
  const fromEnv = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const seen = new Set(fromEnv);
  return [...fromEnv, ...EXTRA_BIN_DIRS.filter((d) => !seen.has(d))];
}

/** PATH（＋補完）から実行可能なバイナリを探す。最初に見つかった絶対パス、無ければ null。 */
export function findOnPath(names: string[]): string | null {
  const dirs = pathSearchDirs();
  for (const name of names) {
    for (const dir of dirs) {
      const c = path.join(dir, name);
      if (isFile(c) && isExecutable(c)) return c;
    }
  }
  return null;
}
