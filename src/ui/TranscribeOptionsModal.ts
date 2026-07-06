import { Modal, Setting } from "obsidian";
import * as path from "path";
import type RemoteMeetingRecorderPlugin from "../main";
import { resolveWhisperModel } from "../transcribe/resolveWhisper";
import type { DupMode } from "../transcribe/insertTranscript";

/** モーダルで選ばれた実行オプション。mode==="abort" なら実行しない。 */
export interface TranscribeOptionsResult {
  model: string;
  language: string;
  dupMode: DupMode;
}

/** モデル選択肢（設定と同じ並び）。 */
const MODEL_OPTIONS: [string, string][] = [
  ["large-v3-turbo-q5_0", "large-v3-turbo（高精度・やや重い）"],
  ["small", "small（速い・バランス）"],
  ["base", "base（最速・軽量）"],
];

/** 言語選択肢（設定と同じ並び）。 */
const LANGUAGE_OPTIONS: [string, string][] = [
  ["ja", "日本語（ja）"],
  ["en", "英語（en）"],
  ["auto", "自動判定（auto）"],
];

/**
 * 右クリック「文字起こし（RMR）」で毎回開く実行オプションのダイアログ。
 * モデル/言語を設定の既定から上書きでき（§4.3/4.4）、既存トランスクリプト検出時は
 * 置換／追記／中止 を選べる（§4.6 重複防止）。
 */
export class TranscribeOptionsModal extends Modal {
  private model: string;
  private language: string;
  private mode: DupMode | "abort";

  constructor(
    private plugin: RemoteMeetingRecorderPlugin,
    private audioName: string,
    private existingDetected: boolean,
    private onRun: (result: TranscribeOptionsResult) => void
  ) {
    super(plugin.app);
    const s = plugin.settings;
    this.model = s.whisperCppModel || "large-v3-turbo-q5_0";
    // 言語は ja/en/auto の3択に正規化（未知の値は ja 扱い）
    this.language = LANGUAGE_OPTIONS.some(([v]) => v === s.transcribeLanguage)
      ? s.transcribeLanguage
      : "ja";
    // 既存があるときの既定は「置換」（より良いモデルでの再文字起こしを想定）。
    this.mode = "replace";
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: "文字起こし（RMR）" });
    contentEl.createEl("p", {
      text: `対象: ${this.audioName}`,
      cls: "rmr-settings-note",
    });

    // モデル
    let modelNote: HTMLElement;
    new Setting(contentEl)
      .setName("モデル")
      .setDesc("精度と速度のトレードオフ。既定は設定値。")
      .addDropdown((d) => {
        for (const [value, label] of MODEL_OPTIONS) d.addOption(value, label);
        d.setValue(this.model).onChange((v) => {
          this.model = v;
          this.updateModelNote(modelNote);
        });
      });
    modelNote = contentEl.createEl("p", { cls: "rmr-settings-note" });
    this.updateModelNote(modelNote);

    // 言語（選択式）
    new Setting(contentEl)
      .setName("言語")
      .setDesc("日本語か英語を選ぶと精度が安定します。auto は音声から自動判定します。")
      .addDropdown((d) => {
        for (const [value, label] of LANGUAGE_OPTIONS) d.addOption(value, label);
        d.setValue(this.language).onChange((v) => {
          this.language = v;
        });
      });

    // 重複時の扱い（既存検出時のみ）
    if (this.existingDetected) {
      new Setting(contentEl)
        .setName("既存の文字起こしを検出")
        .setDesc("この音声には既にトランスクリプトがあります。どうしますか？")
        .addDropdown((d) => {
          d.addOption("replace", "置換（古い結果を上書き）");
          d.addOption("append", "追記（下に足す）");
          d.addOption("abort", "中止（何もしない）");
          d.setValue(this.mode).onChange((v) => {
            this.mode = v as DupMode | "abort";
          });
        });
    }

    // 実行 / キャンセル
    new Setting(contentEl)
      .addButton((b) =>
        b
          .setButtonText("実行")
          .setCta()
          .onClick(() => {
            if (this.mode === "abort") {
              this.close();
              return;
            }
            this.close();
            this.onRun({ model: this.model, language: this.language || "auto", dupMode: this.mode });
          })
      )
      .addButton((b) => b.setButtonText("キャンセル").onClick(() => this.close()));
  }

  onClose(): void {
    this.contentEl.empty();
  }

  /** 選択中モデルが同梱/DL 済みかを注記（未DL なら doctor 案内・§4.3）。 */
  private updateModelNote(el: HTMLElement): void {
    const found = resolveWhisperModel(this.plugin.getPluginDir(), this.model);
    el.removeClass("rmr-tx-model-note-ok", "rmr-tx-model-note-warn");
    if (found) {
      el.setText(`✓ モデル準備済み: ${path.basename(found)}`);
      el.addClass("rmr-tx-model-note-ok");
    } else {
      el.setText("⚠ このモデルは未ダウンロードです。「診断（doctor）」から取得してください。");
      el.addClass("rmr-tx-model-note-warn");
    }
  }
}
