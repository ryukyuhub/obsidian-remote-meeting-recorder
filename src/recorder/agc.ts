/**
 * Windows(Web Audio 経路) 用 AGC の中核。macOS の sysrec `AGCProcessor` と同じ挙動を
 * TypeScript で再現したもの（定数・時定数・ゲート・再アームまで同じ）。
 *
 * なぜ切り出すか: Web Audio ノードに依存しない純関数にしておくと、Windows 実機が無くても
 * ヘッドレスで数値検証できるため（`test/e2e.mjs`）。ノード側は毎 tick この関数の結果を
 * GainNode へ流し込むだけにする。
 *
 * 挙動（sysrec.swift の AGCProcessor と同一）:
 *   - チャンク RMS がゲート（-42 dBFS）を超えるときだけ目標 RMS（-20 dBFS）へ適応する。
 *   - 最初の有音チャンクだけ即時追従（冒頭が数秒小さいままにならない）。以降は上げ遅く／下げ速く。
 *   - ゲート未満（無音・ノイズ床）ではゲインを保持せず 1.0 へ戻す（無音でノイズが膨らむのを防ぐ）。
 *     ほぼ 1.0 へ戻ったら再アームし、次の有音でまた即時追従できるようにする。
 */

/** 目標 RMS = -20 dBFS。 */
export const AGC_TARGET_RMS = 0.1;
/** これ未満は無音／ノイズ床とみなして増幅しない = -42 dBFS。 */
export const AGC_GATE_RMS = 0.0079;
/** 最小ゲイン = -18 dB（過大入力の抑え）。 */
export const AGC_MIN_GAIN = 0.125;
/** 最大ゲイン = +12 dB（小声の持ち上げとノイズ増幅のバランス）。 */
export const AGC_MAX_GAIN = 4.0;

export interface AgcState {
  /** 現在のゲイン（線形）。 */
  gain: number;
  /** 最初の有音チャンクで即時追従済みか。 */
  locked: boolean;
}

export function initialAgcState(): AgcState {
  return { gain: 1, locked: false };
}

/**
 * 1 tick 進めた次の状態を返す（純関数・状態は書き換えない）。
 * @param rms 入力チャンクの RMS（0..1）
 * @param prev 直前の状態
 * @param dtSec この tick の経過秒
 */
export function nextAgcState(rms: number, prev: AgcState, dtSec: number): AgcState {
  if (rms > AGC_GATE_RMS) {
    const desired = Math.min(Math.max(AGC_TARGET_RMS / rms, AGC_MIN_GAIN), AGC_MAX_GAIN);
    if (!prev.locked) return { gain: desired, locked: true }; // 冒頭だけ即追従
    const tau = desired < prev.gain ? 0.4 : 3.0; // 下げは速く・上げはゆっくり
    return { gain: prev.gain + (desired - prev.gain) * (1 - Math.exp(-dtSec / tau)), locked: true };
  }
  // 無音／ノイズ床: ブーストを保持せず 1.0 へ戻す。
  const gain = prev.gain + (1 - prev.gain) * (1 - Math.exp(-dtSec / 0.8));
  return Math.abs(gain - 1) < 0.05 ? { gain: 1, locked: false } : { gain, locked: prev.locked };
}

/** 時間領域サンプル列の RMS（0..1）。 */
export function rmsOf(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}
