/**
 * ライブ波形/レベルメーター描画（設計書 §9.1・§14.3 のレシピ）。
 * level を pow(0.5) ＋微ノイズ → バー高/透明度にして右送りスクロール。
 * accent カラー（--interactive-accent）に追従。
 */
export class WaveformRenderer {
  private raf = 0;
  private bars: number[];
  private readonly count = 56;

  constructor(
    private canvas: HTMLCanvasElement,
    private getLevel: () => number
  ) {
    this.bars = new Array(this.count).fill(0);
  }

  start(): void {
    if (this.raf) return;
    const loop = () => {
      this.draw();
      this.raf = window.requestAnimationFrame(loop);
    };
    loop();
  }

  stop(): void {
    if (this.raf) window.cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  /** 静止クリア（idle / system ソース時）。 */
  clear(): void {
    this.bars.fill(0);
    const ctx = this.canvas.getContext("2d");
    if (ctx) ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  private draw(): void {
    const canvas = this.canvas;
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth || 300;
    const cssH = canvas.clientHeight || 64;
    const w = Math.floor(cssW * dpr);
    const h = Math.floor(cssH * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const level = Math.min(1, Math.max(0, this.getLevel()));
    const shaped = Math.min(1, Math.pow(level, 0.5) + Math.random() * 0.02);
    this.bars.push(shaped);
    if (this.bars.length > this.count) this.bars.shift();

    ctx.clearRect(0, 0, w, h);
    const accent =
      getComputedStyle(canvas).getPropertyValue("--interactive-accent").trim() ||
      "#7c6cf0";

    const gap = 2 * dpr;
    const barW = (w - gap * (this.count - 1)) / this.count;
    const mid = h / 2;
    for (let i = 0; i < this.bars.length; i++) {
      const v = this.bars[i];
      const barH = Math.max(2 * dpr, v * h * 0.9);
      const x = i * (barW + gap);
      ctx.globalAlpha = 0.35 + v * 0.65;
      ctx.fillStyle = accent;
      ctx.fillRect(x, mid - barH / 2, barW, barH);
    }
    ctx.globalAlpha = 1;
  }
}
