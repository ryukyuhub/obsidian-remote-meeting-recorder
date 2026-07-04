import { App, FuzzySuggestModal, TFile } from "obsidian";

/**
 * Vault 内の Markdown ノートを 1 つ選ばせる（更新の新しい順）。
 * 選択せず閉じたら null を返す。録音開始画面の「埋め込み先＝指定ノート」で使う。
 */
export function pickMarkdownNote(app: App): Promise<TFile | null> {
  return new Promise((resolve) => {
    new NotePickerModal(app, resolve).open();
  });
}

class NotePickerModal extends FuzzySuggestModal<TFile> {
  private resolved = false;

  constructor(
    app: App,
    private done: (file: TFile | null) => void
  ) {
    super(app);
    this.setPlaceholder("埋め込み先のノートを選択…");
  }

  getItems(): TFile[] {
    return this.app.vault.getMarkdownFiles().sort((a, b) => b.stat.mtime - a.stat.mtime);
  }

  getItemText(file: TFile): string {
    return file.path;
  }

  onChooseItem(file: TFile): void {
    this.resolved = true;
    this.done(file);
  }

  onClose(): void {
    // 選択せず閉じた（キャンセル）場合のみ null を返す
    if (!this.resolved) this.done(null);
  }
}
