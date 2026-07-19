import type { MicDevice } from "../recorder/devices";

/**
 * レンダラ内（Windows / Web Audio 経路）のマイク入力デバイス一覧（Issue #1）。
 * macOS の sysrec `list-devices` に相当するが、Windows には外部バイナリが無いため
 * `navigator.mediaDevices.enumerateDevices()` の `audioinput` を返す。
 *
 * - `uid` は getUserMedia の `deviceId`（= WebRecorder.micDevice）にそのまま渡せる。
 * - 「規定」は UI 側の空選択が担うので、擬似デバイス（default/communications）は除外する。
 * - ラベルはマイク権限が付与されるまで空になり得る。全て空なら一度だけ getUserMedia で
 *   ラベルを解錠（即停止）して取り直す。取れなければ代替名でフォールバックする。
 */
export async function listWebMicDevices(): Promise<MicDevice[]> {
  try {
    const md = navigator?.mediaDevices;
    if (!md?.enumerateDevices) return [];

    let inputs = pickAudioInputs(await md.enumerateDevices());

    // ラベルが全て空＝未解錠。権限が黙って通る環境（Electron デスクトップ）では
    // 一瞬 getUserMedia して即停止するとラベルが埋まる。失敗は無視して素通し。
    if (inputs.length > 0 && inputs.every((d) => !d.label) && md.getUserMedia) {
      try {
        const s = await md.getUserMedia({ audio: true, video: false });
        s.getTracks().forEach((t) => t.stop());
        inputs = pickAudioInputs(await md.enumerateDevices());
      } catch {
        /* 解錠できなくてもデバイス選択は可能なので継続 */
      }
    }

    return inputs.map((d, i) => ({ uid: d.deviceId, name: d.label || `マイク ${i + 1}` }));
  } catch {
    return [];
  }
}

/** audioinput のうち擬似デバイス（default/communications・空 id）を除いた実デバイス。 */
function pickAudioInputs(devices: MediaDeviceInfo[]): MediaDeviceInfo[] {
  return devices.filter(
    (d) =>
      d.kind === "audioinput" &&
      d.deviceId &&
      d.deviceId !== "default" &&
      d.deviceId !== "communications"
  );
}
