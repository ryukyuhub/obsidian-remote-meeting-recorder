// 時刻ユーティリティ（設計書 §9.2・UX 契約）

/** 2 桁ゼロ埋め。 */
export function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

/** ローカル日付 `YYYY-MM-DD`。 */
export function formatDate(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** ローカル時刻 `HH:MM`。 */
export function formatClock(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/**
 * 既定ファイル名 `YYYY-MM-DD-HHMM`（ローカル時刻・拡張子なし stem）。
 * 呼び出し側で `.m4a` を付与する。
 */
export function defaultFilename(d: Date = new Date()): string {
  return `${formatDate(d)}-${pad2(d.getHours())}${pad2(d.getMinutes())}`;
}

/** ローカル日時 `YYYY-MM-DD HH:MM`（復旧待ち録音の表示用）。 */
export function formatDateTime(d: Date): string {
  return `${formatDate(d)} ${formatClock(d)}`;
}

/** 録音の長さを日本語で（例「1時間13分」「45秒」）。復旧待ち録音の表示用。 */
export function formatDuration(totalSec: number): string {
  const s = Math.max(0, Math.round(totalSec));
  if (s < 60) return `${s}秒`;
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  if (h > 0) return m > 0 ? `${h}時間${m}分` : `${h}時間`;
  return `${m}分`;
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
