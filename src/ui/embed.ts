import { App, MarkdownView, Notice, TFile, normalizePath } from "obsidian";
import * as path from "path";
import { getVaultBasePath } from "../context";

/** 絶対パスを Vault 相対パスに変換（Vault 外なら null）。 */
export function computeVaultRelative(app: App, absPath: string): string | null {
  const base = getVaultBasePath(app);
  if (!base) return null;
  const rel = path.relative(base, absPath);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return normalizePath(rel);
}

/** Vault 相対パスから埋め込みリンク文字列 `![[rel]]` を作る。 */
export function wikilinkEmbed(rel: string): string {
  return `![[${rel}]]`;
}

/**
 * 停止時に `![[<相対>.m4a]]` を挿入（設計書 §9.4）。
 * 埋め込み先は録音開始時にキャプチャしたノートに固定（長時間録音中の切替に強い）。
 * Vault 外/ノート無しは絶対パスを Notice で知らせる。
 */
export async function insertEmbed(
  app: App,
  startFile: TFile | null,
  absPath: string
): Promise<boolean> {
  const rel = computeVaultRelative(app, absPath);
  if (!rel) {
    new Notice(`録音を保存しました（Vault 外）:\n${absPath}`);
    return false;
  }
  const link = wikilinkEmbed(rel);

  if (startFile) {
    // 開始時のノートがアクティブエディタで開かれていればカーソル位置へ、
    // そうでなければファイル末尾に追記（ノート切替をまたいでも確実に入れる）。
    const view = app.workspace.getActiveViewOfType(MarkdownView);
    if (view && view.file && view.file.path === startFile.path && view.editor) {
      view.editor.replaceSelection(`${link}\n`);
      return true;
    }
    try {
      await app.vault.append(startFile, `\n${link}\n`);
      return true;
    } catch {
      // フォールバック: 現在のアクティブエディタ
    }
  }

  const view = app.workspace.getActiveViewOfType(MarkdownView);
  if (view && view.editor) {
    view.editor.replaceSelection(`${link}\n`);
    return true;
  }

  new Notice(`録音を保存しました:\n${rel}\n（挿入先ノートが見つかりません）`);
  return false;
}
