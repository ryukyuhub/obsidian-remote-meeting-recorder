/**
 * ステータスバー制御（設計書 §9.4）。
 * 録音中の常時表示は行わず、mix 失敗（remix 待ち）の警告表示のみに使う。
 * クリックで録音ビューを開く。
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

  /** 保存が完了していない録音がある旨の表示（クリックで録音ビューへ）。 */
  setWarning(count: number): void {
    this.el.setText(`⚠ 未保存の録音 ${count} 件`);
    this.el.addClass("rmr-statusbar-warning");
    this.el.removeClass("rmr-hidden");
  }

  /** 非表示（録音していない）。 */
  clear(): void {
    this.el.setText("");
    this.el.removeClass("rmr-statusbar-warning");
    this.el.addClass("rmr-hidden");
  }
}
