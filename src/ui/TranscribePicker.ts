import { FuzzySuggestModal, Notice, TFile } from "obsidian";
import * as path from "path";
import type RemoteMeetingRecorderPlugin from "../main";
import { getVaultBasePath } from "../context";
import { getElectronRemote } from "../platform/electron";
import { AUDIO_EXTS } from "../transcribe/audioFormats";

/* eslint-disable @typescript-eslint/no-explicit-any -- Electron の remote.dialog は型情報が乏しく any 経由で扱う */

interface Choice {
  label: string;
  kind: "vault" | "browse";
  file?: TFile;
}

/**
 * 既存の録音ファイルを選んで文字起こしする（設計書 §15.2 ①・手動起動）。
 * Vault 内の音声を新しい順に一覧。先頭に「Vault 外を選択…」（Electron ダイアログ）。
 */
export class TranscribePicker extends FuzzySuggestModal<Choice> {
  constructor(private plugin: RemoteMeetingRecorderPlugin) {
    super(plugin.app);
    this.setPlaceholder("文字起こしする録音を選択（新しい順）");
  }

  getItems(): Choice[] {
    const files = this.app.vault
      .getFiles()
      .filter((f) => AUDIO_EXTS.includes(f.extension.toLowerCase()))
      .sort((a, b) => b.stat.mtime - a.stat.mtime);
    const items: Choice[] = files.map((f) => ({ label: f.path, kind: "vault", file: f }));
    items.unshift({ label: "📁 Vault 外のファイルを選択…", kind: "browse" });
    return items;
  }

  getItemText(item: Choice): string {
    return item.label;
  }

  onChooseItem(item: Choice): void {
    if (item.kind === "browse") {
      void this.browse();
      return;
    }
    if (item.file) {
      const base = getVaultBasePath(this.app);
      if (!base) {
        new Notice("Vault パスを取得できません。");
        return;
      }
      void this.plugin.transcribeFile(path.join(base, item.file.path));
    }
  }

  private async browse(): Promise<void> {
    const remote = getElectronRemote() as any;
    const dialog = remote?.dialog;
    if (!dialog) {
      new Notice("ファイル選択ダイアログを開けません（この環境では未対応）。");
      return;
    }
    try {
      const res = await dialog.showOpenDialog({
        properties: ["openFile"],
        filters: [{ name: "音声", extensions: AUDIO_EXTS }],
      });
      if (res.canceled || !res.filePaths?.length) return;
      void this.plugin.transcribeFile(res.filePaths[0]);
    } catch (e) {
      new Notice(`ファイル選択に失敗しました: ${(e as Error).message}`);
    }
  }
}
