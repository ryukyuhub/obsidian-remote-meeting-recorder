// 時刻ユーティリティ（設計書 §9.2・UX 契約）

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

/**
 * 既定ファイル名 `YYYY-MM-DD-HHMM`（ローカル時刻・拡張子なし stem）。
 * 呼び出し側で `.m4a` を付与する。
 */
export function defaultFilename(d: Date = new Date()): string {
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` +
    `-${pad2(d.getHours())}${pad2(d.getMinutes())}`
  );
}

/** 経過秒を `M:SS` / `H:MM:SS` に整形（status bar 用）。 */
export function formatElapsed(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${pad2(m)}:${pad2(sec)}`;
  return `${m}:${pad2(sec)}`;
}
