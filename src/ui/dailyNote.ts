import { App, TFile, normalizePath } from "obsidian";

/**
 * デイリーノート連携（設計書 §13・Phase 4）。
 * コア「デイリーノート」プラグインの設定（format/folder）から今日のノートを解決し、
 * 埋め込みリンクを追記する。best-effort（未設定・失敗時は false）。
 */
export async function linkToDailyNote(app: App, embedRel: string): Promise<boolean> {
  try {
    const file = await resolveDailyNote(app);
    if (file) {
      await app.vault.append(file, `\n![[${embedRel}]]\n`);
      return true;
    }
  } catch {
    // 連携失敗は致命でない（埋め込み本体は別途挿入済み）
  }
  return false;
}

/**
 * 今日のデイリーノートを解決（無ければ作成）して返す。
 * コア「デイリーノート」プラグインが無効・未設定なら null（best-effort）。
 * 文字起こしの未選択時フォールバック先としても使う。
 */
export async function resolveDailyNote(app: App): Promise<TFile | null> {
  try {
    // 内部 API（型は非公開）。デイリーノートが有効なときだけ動く。
    const internal = (app as unknown as {
      internalPlugins?: {
        getPluginById?: (id: string) => { enabled?: boolean; instance?: unknown } | null;
      };
    }).internalPlugins;
    const dn = internal?.getPluginById?.("daily-notes");
    if (!dn?.enabled || !dn.instance) return null;

    const opts = (dn.instance as { options?: { format?: string; folder?: string } }).options ?? {};
    const format = opts.format || "YYYY-MM-DD";
    const folder = (opts.folder || "").trim();

    const moment = (window as unknown as { moment: (d?: unknown) => { format: (f: string) => string } }).moment;
    const dateStr = moment().format(format);
    const notePath = normalizePath((folder ? `${folder}/` : "") + `${dateStr}.md`);

    let file = app.vault.getAbstractFileByPath(notePath);
    if (!file) {
      if (folder) await ensureFolder(app, folder);
      file = await app.vault.create(notePath, "");
    }
    return file instanceof TFile ? file : null;
  } catch {
    return null;
  }
}

async function ensureFolder(app: App, folder: string): Promise<void> {
  const norm = normalizePath(folder);
  if (app.vault.getAbstractFileByPath(norm)) return;
  try {
    await app.vault.createFolder(norm);
  } catch {
    // 既存/競合は無視
  }
}
