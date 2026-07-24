import * as fs from "fs";

/**
 * sysrec が出力する level ファイル（`<id>.level` の JSON `{system,mic}`）を定期ポーリングして
 * 保持する（録音中の 2 メーター用）。SessionWatcher（1s/3s 粒度の終端検知）とは責務が違うため
 * 別タイマーにする。ミニ窓のレベル送出（60ms）と同じ軽量ポーリング。
 */
export class LevelPoller {
  private timer: number | null = null;
  private system = 0;
  private mic = 0;

  constructor(
    private readonly levelPath: string,
    private readonly intervalMs = 66
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = window.setInterval(() => this.read(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
    this.system = 0;
    this.mic = 0;
  }

  /** 直近のソース別レベル（0..1）。 */
  levels(): { system: number; mic: number } {
    return { system: this.system, mic: this.mic };
  }

  private read(): void {
    try {
      const obj = JSON.parse(fs.readFileSync(this.levelPath, "utf8")) as {
        system?: number;
        mic?: number;
      };
      if (typeof obj.system === "number") this.system = obj.system;
      if (typeof obj.mic === "number") this.mic = obj.mic;
    } catch {
      // まだ無い / atomic 上書き中で読めない → 前値を保持
    }
  }
}
