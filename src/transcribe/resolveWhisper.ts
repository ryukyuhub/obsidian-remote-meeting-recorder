import * as fs from "fs";
import * as path from "path";

/* whisper.cpp バイナリ / モデルの解決（sysrec の resolveBin と同じ思想）。 */

function isExec(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * PATH 検索ディレクトリ。Obsidian（GUI アプリ）の process.env.PATH には
 * /opt/homebrew/bin 等が含まれないため、Homebrew/MacPorts の標準パスを補う。
 */
function pathDirs(): string[] {
  const fromEnv = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const common = ["/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin"];
  const seen = new Set(fromEnv);
  return [...fromEnv, ...common.filter((d) => !seen.has(d))];
}

function findOnPath(names: string[]): string | null {
  const dirs = pathDirs();
  for (const name of names) {
    for (const dir of dirs) {
      const c = path.join(dir, name);
      if (isFile(c) && isExec(c)) return c;
    }
  }
  return null;
}

export function whisperDir(pluginDir: string): string {
  return path.join(pluginDir, "native", "whisper");
}

export function whisperModelsDir(pluginDir: string): string {
  return path.join(whisperDir(pluginDir), "models");
}

/** native/whisper/ 以下を浅く走査して whisper-cli(.exe)/main(.exe) を探す（zip 展開のレイアウト差を吸収）。 */
function shallowFindExe(root: string, names: string[], maxDepth: number): string | null {
  const walk = (dir: string, depth: number): string | null => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isFile() && names.includes(e.name)) return p;
    }
    if (depth < maxDepth) {
      for (const e of entries) {
        if (e.isDirectory()) {
          const found = walk(path.join(dir, e.name), depth + 1);
          if (found) return found;
        }
      }
    }
    return null;
  };
  return walk(root, 0);
}

/**
 * whisper.cpp CLI を解決。優先: 設定 → native/whisper/(build/bin/…)whisper-cli(.exe) → 浅い走査 → PATH。
 * Windows は `whisper-cli.exe`、その他は `whisper-cli`。見つからなければ ""。
 */
export function resolveWhisperBin(pluginDir: string, override: string): string {
  const ov = (override || "").trim();
  if (ov && isFile(ov)) return ov;
  const dir = whisperDir(pluginDir);
  const win = process.platform === "win32";
  const exe = win ? ".exe" : "";
  const candidates = [
    path.join(dir, `whisper-cli${exe}`),
    path.join(dir, "build", "bin", `whisper-cli${exe}`),
    path.join(dir, "build", "bin", "Release", `whisper-cli${exe}`),
    path.join(dir, "Release", `whisper-cli${exe}`),
    path.join(dir, `main${exe}`),
  ];
  for (const c of candidates) if (isFile(c)) return c;
  if (win) {
    // Windows のビルド済み zip は展開先の階層が版によって異なるため浅く走査する。
    const found = shallowFindExe(dir, ["whisper-cli.exe", "main.exe"], 2);
    if (found) return found;
  }
  return findOnPath(win ? ["whisper-cli.exe", "whisper.exe"] : ["whisper-cli", "whisper"]) ?? "";
}

/** モデル名/パスを ggml .bin の絶対パスへ解決。空指定は models/ 内の最初の ggml を採用。 */
export function resolveWhisperModel(pluginDir: string, spec: string): string {
  const s = (spec || "").trim();
  const dir = whisperModelsDir(pluginDir);
  if (!s) {
    try {
      const found = fs
        .readdirSync(dir)
        .filter((f) => /^ggml-.*\.bin$/.test(f))
        .sort();
      if (found.length) return path.join(dir, found[0]);
    } catch {
      // models ディレクトリ無し
    }
    return "";
  }
  if (path.isAbsolute(s) && isFile(s)) return s;
  const fileName = s.endsWith(".bin") ? s : s.startsWith("ggml-") ? `${s}.bin` : `ggml-${s}.bin`;
  const p = path.join(dir, fileName);
  return isFile(p) ? p : "";
}

/** ダウンロード先のモデルパス（doctor のモデル取得で使用）。 */
export function modelDownloadTarget(pluginDir: string, modelName: string): string {
  const name = modelName.startsWith("ggml-") ? modelName : `ggml-${modelName}`;
  const fileName = name.endsWith(".bin") ? name : `${name}.bin`;
  return path.join(whisperModelsDir(pluginDir), fileName);
}
