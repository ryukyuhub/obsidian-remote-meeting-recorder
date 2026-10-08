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

    // ラベルが全て空＝未解錠。解錠できなくてもデバイス選択は可能なので、失敗は無視して素通し。
    if (inputs.length > 0 && inputs.every((d) => !d.label) && (await unlockDeviceLabels(md))) {
      inputs = pickAudioInputs(await md.enumerateDevices());
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

/**
 * デバイスラベルの解錠。権限が黙って通る環境（Electron デスクトップ）では一瞬 getUserMedia
 * して即停止するとラベルが埋まる。解錠できたかを返す（失敗は throw せず false）。
 * `timeoutMs` を渡すと、その時間内に getUserMedia が応答しなければ false で打ち切る
 * （診断が止まらないようにするため）。打ち切った後に遅れて取れたストリームも必ず止める。
 */
async function unlockDeviceLabels(md: MediaDevices, timeoutMs?: number): Promise<boolean> {
  if (!md.getUserMedia) return false;
  // ストリームは race の勝敗に関わらずここで止める（遅れて取れてもマイクを開きっぱなしにしない）。
  const acquire = Promise.resolve()
    .then(() => md.getUserMedia({ audio: true, video: false }))
    .then(
      (s) => {
        s.getTracks().forEach((t) => t.stop());
        return true;
      },
      () => false
    );
  if (timeoutMs == null) return acquire;
  let timer: number | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = window.setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    return await Promise.race([acquire, timeout]);
  } finally {
    window.clearTimeout(timer);
  }
}

// --- 再生（出力）デバイスの「既定」と「通信」 ------------------------------------
//
// システム音声のループバック（Electron の `audio: "loopback"`）は、Chromium の実装上
// Windows の「既定の再生デバイス」（eConsole）1 本だけを録音する。会議アプリ（ブラウザの
// Meet など）の音が「既定の通信デバイス」や別のヘッドセットへ出ていると取りこぼし、
// マイクは録れているのにシステム音声だけが無音になる。Chromium は enumerateDevices の
// `audiooutput` に擬似エントリ `default`（既定）と `communications`（通信・Windows のみ）を
// 出すので、その 2 つが指す実デバイスを比べてずれを検出する。

/** 診断のラベル解錠（getUserMedia）の待ち時間の上限。応答が無くても診断を止めない。 */
const LABEL_UNLOCK_TIMEOUT_MS = 4000;

/** 再生デバイスの既定／通信の対応。どれも判定できなければ null が入る。 */
export interface OutputRouting {
  /** 既定の再生デバイスの実デバイス名（判定不能なら null）。 */
  defaultName: string | null;
  /** 既定の通信デバイスの実デバイス名（判定不能なら null）。 */
  communicationsName: string | null;
  /** 既定と通信が別の機器なら true、同じなら false、判定不能なら null（＝警告しない）。 */
  mismatch: boolean | null;
}

/** outputRoutingOf が見る MediaDeviceInfo の最小形（純関数として試験しやすくするため）。 */
type DeviceInfoLike = Pick<MediaDeviceInfo, "kind" | "deviceId" | "label" | "groupId">;

/**
 * Chromium の擬似デバイスのラベルから実デバイス名を取り出す（純関数）。
 * ラベルは「<ローカライズされた接頭辞> - <実デバイス名>」形式（例: "Default - Speakers (Realtek(R) Audio)"、
 * "既定 - スピーカー (…)"、"Communications - …"、"通信 - …"）。接頭辞は言語で変わるので照合せず、
 * 最初の " - " より後ろを実デバイス名とする。空ラベル（権限前）と " - " の無いラベルは null（判定不能）。
 * 後者を判定不能にするのは、接頭辞だけのラベル（"Default" / "Communications" 等）を実デバイス名と
 * 取り違えると、既定と通信が常に「別の機器」に見えて誤警告になるため。
 */
export function realDeviceNameOf(label: string): string | null {
  const s = label.trim();
  const i = s.indexOf(" - ");
  if (i < 0) return null;
  return s.slice(i + 3).trim() || null;
}

/**
 * enumerateDevices の結果から既定／通信の再生デバイスとそのずれを判定する（純関数）。
 * 手段は 2 つあり、**どちらかで差が出たら「ずれ」**とする:
 *   - 実デバイス名 … 両方取れたときだけ使う。
 *   - groupId … 擬似エントリ `default` と `communications` の groupId がどちらも実デバイス（擬似でない
 *     `audiooutput`）のいずれかと一致するときだけ使う（擬似エントリが独自の groupId を持つ実装で
 *     誤判定しないため）。
 * 片方だけで「一致」を決めないのは、groupId が機器（コンテナ）単位だと別の端点が同じ値になりうるため
 * （例: Bluetooth ヘッドセットのステレオ端点とハンズフリー端点）。同じ端点なら名前も groupId も一致する
 * はずなので、差の OR を取っても誤警告は増えない。
 * 使える手段で差が無ければ一致（false）、どちらも使えなければ判定不能（null）。ラベルが空（権限前）・
 * communications エントリが無い（Windows 以外）などがこれに当たる。
 */
export function outputRoutingOf(devices: readonly DeviceInfoLike[]): OutputRouting {
  const outputs = devices.filter((d) => d.kind === "audiooutput");
  const def = outputs.find((d) => d.deviceId === "default");
  const comm = outputs.find((d) => d.deviceId === "communications");
  const realGroups = new Set(
    outputs
      .filter((d) => d.deviceId && d.deviceId !== "default" && d.deviceId !== "communications")
      .map((d) => d.groupId)
      .filter((g) => !!g)
  );
  const defaultName = def ? realDeviceNameOf(def.label) : null;
  const communicationsName = comm ? realDeviceNameOf(comm.label) : null;

  const byName = defaultName != null && communicationsName != null;
  const byGroup = !!def && !!comm && realGroups.has(def.groupId) && realGroups.has(comm.groupId);
  const mismatch =
    (byName && defaultName !== communicationsName) || (byGroup && def.groupId !== comm.groupId)
      ? true
      : byName || byGroup
        ? false
        : null;
  return { defaultName, communicationsName, mismatch };
}

/**
 * 現在の再生デバイスの既定／通信の対応を調べる（失敗は判定不能として返し、throw しない）。
 * `unlockLabels` が真なら、再生デバイスのラベルが全て空のとき一度だけ解錠（マイクを一瞬開く・
 * 最大 LABEL_UNLOCK_TIMEOUT_MS 待つ）してから取り直す。診断から使う。
 * 録音開始時は解錠しない（録音中に余計なマイク取得をしない）。マイクを含む録音では取得済みの
 * マイクでラベルが埋まるが、システム音声のみの録音ではマイクを開かないため、ラベルが空のまま
 * 判定不能（mismatch: null）になりうる。
 */
export async function getOutputRouting(
  opts: { unlockLabels?: boolean } = {}
): Promise<OutputRouting> {
  const unknown: OutputRouting = { defaultName: null, communicationsName: null, mismatch: null };
  try {
    const md = navigator?.mediaDevices;
    if (!md?.enumerateDevices) return unknown;
    let devices = await md.enumerateDevices();
    const outputs = devices.filter((d) => d.kind === "audiooutput");
    if (
      opts.unlockLabels &&
      outputs.length > 0 &&
      outputs.every((d) => !d.label) &&
      (await unlockDeviceLabels(md, LABEL_UNLOCK_TIMEOUT_MS))
    ) {
      devices = await md.enumerateDevices();
    }
    return outputRoutingOf(devices);
  } catch {
    return unknown;
  }
}

/** 「既定の再生デバイス『名前』」（名前が取れなければ「既定の再生デバイス」）。文言の部品。 */
export function defaultOutputPhrase(r: OutputRouting | null): string {
  return r?.defaultName ? `既定の再生デバイス『${r.defaultName}』` : "既定の再生デバイス";
}

/**
 * 「システム音声は既定の再生デバイスだけを録る」旨の案内文（Notice・診断で共通）。
 * 既定の再生デバイス名が取れていれば名前を、ずれが分かっていれば通信デバイス名も添える。
 */
export function loopbackSourceHint(r: OutputRouting | null): string {
  const def = defaultOutputPhrase(r);
  const comm =
    r?.mismatch && r.communicationsName ? `既定の通信デバイスは『${r.communicationsName}』です。` : "";
  return (
    `システム音声は Windows の${def}だけを録音します。${comm}` +
    "会議アプリ（ブラウザの Meet など）のスピーカー設定を「既定」に合わせてください。"
  );
}
