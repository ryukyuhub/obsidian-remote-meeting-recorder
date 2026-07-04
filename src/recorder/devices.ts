import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

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
    const arr = JSON.parse(stdout);
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (d): d is MicDevice =>
        d && typeof d.uid === "string" && typeof d.name === "string"
    );
  } catch {
    return [];
  }
}
