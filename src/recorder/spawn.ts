import { spawn } from "child_process";
import * as fs from "fs";
import { delay } from "../util/delay";

/**
 * pid が生存しているか（設計書 §8.1）。
 * EPERM は「他ユーザ所有だが存在する」= 生存扱い。
 */
export function isAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * pidfile を最大 tries×everyMs だけ待って pid を読む（既定 0.1s×30 = 3s）。
 * バイナリが pidfile を書くまでの起動ハンドシェイク（設計書 §3.3）。
 */
export async function pollPidFile(
  pidPath: string,
  tries = 30,
  everyMs = 100
): Promise<number | null> {
  for (let i = 0; i < tries; i++) {
    try {
      const txt = fs.readFileSync(pidPath, "utf8").trim();
      const pid = parseInt(txt, 10);
      if (Number.isFinite(pid) && pid > 0) return pid;
    } catch {
      // まだ書かれていない
    }
    await delay(everyMs);
  }
  return null;
}

/**
 * detached でバイナリを起動し pid を返す。stderr はログファイルへ。
 * unref でレンダラ終了後もプロセスが生存継続できるようにする（設計書 §6-7）。
 */
export function spawnDetached(bin: string, argv: string[], logPath: string): number {
  const logFd = fs.openSync(logPath, "a");
  try {
    const child = spawn(bin, argv, {
      detached: true,
      stdio: ["ignore", "ignore", logFd],
    });
    child.unref();
    const pid = child.pid;
    if (!pid) throw new Error("spawn 失敗: pid を取得できません");
    return pid;
  } finally {
    // 子は fd の dup を保持するので親側は閉じてよい
    fs.closeSync(logFd);
  }
}

/**
 * caffeinate -i -m -w <pid> を detached 起動（スリープ抑止の保険）。
 * 対象 pid の終了で caffeinate も自動終了（消し忘れゼロ）。
 */
export function spawnCaffeinate(pid: number): void {
  try {
    const child = spawn("caffeinate", ["-i", "-m", "-w", String(pid)], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  } catch {
    // caffeinate が無くても録音自体は継続する（バイナリ内でも抑止している）
  }
}
