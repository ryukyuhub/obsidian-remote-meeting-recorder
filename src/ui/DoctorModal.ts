import { App, Modal, Notice, Setting } from "obsidian";
import type RemoteMeetingRecorderPlugin from "../main";
import { runDoctor, type DoctorCheck, type DoctorStatus } from "../doctor/diagnostics";

const STATUS_LABEL: Record<DoctorStatus, string> = {
  ok: "[OK]",
  ng: "[NG]",
  warn: "[WARN]",
  info: "[INFO]",
};

/** 診断結果を [OK]/[NG]/[WARN] + 直し方で表示（設計書 §9.4）。 */
export class DoctorModal extends Modal {
  plugin: RemoteMeetingRecorderPlugin;

  constructor(app: App, plugin: RemoteMeetingRecorderPlugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen(): void {
    this.render();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("rmr-doctor");

    contentEl.createEl("h2", { text: "診断（doctor）" });

    let checks: DoctorCheck[];
    try {
      checks = runDoctor(this.plugin.buildContext());
    } catch (e) {
      contentEl.createEl("p", { text: `診断の実行に失敗しました: ${(e as Error).message}` });
      return;
    }

    for (const check of checks) {
      const setting = new Setting(contentEl)
        .setName(`${STATUS_LABEL[check.status]} ${check.label}`)
        .setDesc(check.detail);
      setting.settingEl.addClass(`rmr-doctor-${check.status}`);

      if (check.fix) {
        const fix = check.fix;
        setting.addButton((btn) =>
          btn.setButtonText(fix.label).onClick(async () => {
            btn.setDisabled(true);
            btn.setButtonText("実行中…");
            try {
              const msg = await fix.run();
              new Notice(msg);
              this.render(); // 再診断
            } catch (err) {
              new Notice(`失敗: ${(err as Error).message}`);
              btn.setDisabled(false);
              btn.setButtonText(fix.label);
            }
          })
        );
      }
    }

    new Setting(contentEl).addButton((btn) =>
      btn
        .setButtonText("再診断")
        .setCta()
        .onClick(() => this.render())
    );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
