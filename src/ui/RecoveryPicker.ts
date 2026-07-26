import { App, FuzzySuggestModal } from "obsidian";
import type { PendingRecovery } from "../types";
import { formatDateTime, formatDuration } from "../util/time";

/** 復旧待ち録音 1 件の表示文字列（日時・長さが分かるように）。 */
export function describePendingRecovery(p: PendingRecovery): string {
  const when = formatDateTime(new Date(p.startedAt));
  const len = p.durationSec != null ? `・${formatDuration(p.durationSec)}` : "";
  return `${p.label}（${when}${len}）`;
}

/**
 * 復旧待ちが複数あるときに 1 件選ばせる（設計書 §8.1・Issue #6）。
 * 選択せず閉じたら null を返す。
 */
export function pickPendingRecovery(
  app: App,
  items: PendingRecovery[]
): Promise<PendingRecovery | null> {
  return new Promise((resolve) => {
    new RecoveryPickerModal(app, items, resolve).open();
  });
}

class RecoveryPickerModal extends FuzzySuggestModal<PendingRecovery> {
  private resolved = false;

  constructor(
    app: App,
    private items: PendingRecovery[],
    private done: (p: PendingRecovery | null) => void
  ) {
    super(app);
    this.setPlaceholder("復旧する録音を選択…");
  }

  getItems(): PendingRecovery[] {
    // 新しい録音ほど心当たりがあるので新しい順。
    return [...this.items].sort((a, b) => b.startedAt - a.startedAt);
  }

  getItemText(p: PendingRecovery): string {
    return describePendingRecovery(p);
  }

  onChooseItem(p: PendingRecovery): void {
    this.resolved = true;
    this.done(p);
  }

  onClose(): void {
    if (!this.resolved) this.done(null);
  }
}
