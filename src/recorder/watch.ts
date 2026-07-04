import type { RecorderContext } from "../context";
import type { SessionMeta, TerminalEvent } from "../types";
import { sessionPaths } from "../state/paths";
import { isAlive } from "./spawn";
import { finalizeSession, statusHasStopped } from "./stop";

export type TickHandler = (elapsedSec: number) => void;
export type TerminalHandler = (ev: TerminalEvent) => void;

/**
 * セッション監視（設計書 §7）。1 秒 tick で elapsed を通知、3 tick 毎に
 * liveness + status を確認し、stopped 検出 or pid 死亡で finalize → onTerminal。
 * 明示停止・蓋閉じ・クラッシュの全経路をここへ集約する。
 * fs.watch ではなく poll（sleep/wake をまたぐ append に強い・elapsed 時計にも必要）。
 */
export class SessionWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private tick = 0;
  private finalizing = false;

  constructor(
    private ctx: RecorderContext,
    public meta: SessionMeta,
    private onTick: TickHandler,
    private onTerminal: TerminalHandler
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.onInterval(), 1000);
    void this.onInterval(); // 即時 1 回
  }

  /** interval を止めるだけ（sysrec は殺さない・設計書 §6-7）。 */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  get sessionId(): string {
    return this.meta.id;
  }

  private async onInterval(): Promise<void> {
    const elapsed = (Date.now() - this.meta.startedAt) / 1000;
    this.onTick(elapsed);

    this.tick++;
    if (this.tick % 3 !== 0) return;

    const sp = sessionPaths(this.ctx.paths, this.meta.id);
    const stopped = statusHasStopped(sp.status);
    const dead = !isAlive(this.meta.pid);
    if ((stopped || dead) && !this.finalizing) {
      this.finalizing = true;
      this.stop();
      const ev = await finalizeSession(this.ctx, this.meta);
      this.onTerminal(ev);
    }
  }
}
