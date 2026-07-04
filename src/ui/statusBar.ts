import { formatElapsed } from "../util/time";

/**
 * ステータスバー制御（設計書 §9.4）。
 * `● REC 12:34` を各 SessionWatcher.onTick で更新。クリックで停止/ビューへ。
 * Phase 0 では土台のみ（録音が入る Phase 1 以降で active 表示を使う）。
 */
export class StatusBarController {
  private el: HTMLElement;
  private onClick: (() => void) | null = null;

  constructor(el: HTMLElement) {
    this.el = el;
    this.el.addClass("rmr-statusbar");
    this.el.addEventListener("click", () => this.onClick?.());
    this.clear();
  }

  setClickHandler(handler: (() => void) | null): void {
    this.onClick = handler;
  }

  /** 録音中表示（経過秒）。 */
  setRecording(elapsedSec: number): void {
    this.el.setText(`● REC ${formatElapsed(elapsedSec)}`);
    this.el.removeClass("rmr-statusbar-warning");
    this.el.addClass("rmr-statusbar-active");
    this.el.removeClass("rmr-hidden");
  }

  /** mix 失敗（remix 待ち）表示。 */
  setWarning(): void {
    this.el.setText("⚠ remix needed");
    this.el.removeClass("rmr-statusbar-active");
    this.el.addClass("rmr-statusbar-warning");
    this.el.removeClass("rmr-hidden");
  }

  /** 非表示（録音していない）。 */
  clear(): void {
    this.el.setText("");
    this.el.removeClass("rmr-statusbar-active");
    this.el.removeClass("rmr-statusbar-warning");
    this.el.addClass("rmr-hidden");
  }
}
