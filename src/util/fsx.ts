import { promises as fsp } from "fs";
import * as fs from "fs";
import * as path from "path";

/** ディレクトリを再帰的に作成（既存でもエラーにしない）。 */
export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

/** ファイル/ディレクトリの存在確認（例外を投げない）。 */
export function exists(p: string): boolean {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

/** ファイルサイズ（バイト）。無ければ 0。 */
export function statBytes(p: string): number {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

/** 中身のあるファイルが存在するか（0 バイトは「録れていない」扱い）。 */
export function existsWithSize(p: string): boolean {
  return statBytes(p) > 0;
}

/** 拡張子を除いたパス（Swift の deletingPathExtension 相当）。 */
export function stripExt(p: string): string {
  const ext = path.extname(p);
  return ext ? p.slice(0, p.length - ext.length) : p;
}

/** both の中間ファイルパス（<base>.sys.m4a / <base>.mic.m4a・設計書 §4.1）。 */
export function intermediatePaths(out: string): { sys: string; mic: string } {
  const base = stripExt(out);
  return { sys: `${base}.sys.m4a`, mic: `${base}.mic.m4a` };
}

/**
 * アトミック書き込み: tmp に書いて rename する。
 * 半端な JSON をディスクに残さないため、セッションメタ書き込みで必須（設計書 §5.2）。
 */
export function atomicWriteFile(dest: string, data: string): void {
  ensureDir(path.dirname(dest));
  const tmp = `${dest}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, data, "utf8");
  fs.renameSync(tmp, dest);
}

/**
 * ファイル末尾 n 行を返す（起動失敗時のログ提示用）。
 * ファイルが無い/読めない場合は空文字。
 */
export function tailFile(p: string, n: number): string {
  try {
    const text = fs.readFileSync(p, "utf8");
    const lines = text.split(/\r?\n/);
    return lines.slice(Math.max(0, lines.length - n)).join("\n").trim();
  } catch {
    return "";
  }
}

/** 非同期版 tail（大きめログ向け）。 */
export async function tailFileAsync(p: string, n: number): Promise<string> {
  try {
    const text = await fsp.readFile(p, "utf8");
    const lines = text.split(/\r?\n/);
    return lines.slice(Math.max(0, lines.length - n)).join("\n").trim();
  } catch {
    return "";
  }
}
