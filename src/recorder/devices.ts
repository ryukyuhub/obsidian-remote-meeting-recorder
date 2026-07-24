import { execFileAsync } from "../util/exec";

/** マイク入力デバイス（uid は sysrec --mic-device にそのまま渡せる）。 */
export interface MicDevice {
  uid: string;
  name: string;
}

/**
 * `sysrec list-devices` でマイク一覧を取得（§4.6）。
 * バイナリ未検出・古いバイナリ・失敗時は空配列（＝「既定」のみ）。
 */
export async function listMicDevices(bin: string): Promise<MicDevice[]> {
  if (!bin) return [];
  try {
    const { stdout } = await execFileAsync(bin, ["list-devices"], { timeout: 5000 });
    const arr: unknown = JSON.parse(stdout);
    if (!Array.isArray(arr)) return [];
    return arr.filter((d: unknown): d is MicDevice => {
      const o = d as { uid?: unknown; name?: unknown } | null;
      return !!o && typeof o.uid === "string" && typeof o.name === "string";
    });
  } catch {
    return [];
  }
}
