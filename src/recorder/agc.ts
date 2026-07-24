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

// ============================================================
// 仕上げ正規化（Windows 版）
// ============================================================
//
// macOS は停止後に `sysrec normalize` でファイル全体を測って -16 dBFS へ揃える。Windows は
// MediaRecorder が最終ファイルを直接書くうえ、Chromium が **AAC をエンコードできない**ため
// （実測: AudioEncoder は opus のみ対応）、.m4a を保ったままの保存時正規化ができない。
//
// そこで取り込み時に等価なことをする。狙いは「録音レベルを OS の出力音量から独立させる」こと。
// Windows のシステム音声は WASAPI ループバック＝出力ミックスを拾うので、出力音量を下げると
// 取り込みも小さくなる（macOS の Core Audio タップは音量つまみより手前なので影響しない）。
// その減衰は録音中ほぼ一定なので、**累積測定から収束する静的ゲイン**で正しく打ち消せる。
//
// AGC との違い（両方掛かる。macOS も 録音時 AGC → 保存時 normalize の二段）:
//   - AGC は「時間方向のばらつき」を均す。速く動き、無音では 1.0 へ戻る。
//   - こちらは「録音全体の音量」を目標へ寄せる。累積平均なので時間とともに動かなくなる。
// AutoGain のオン/オフに関わらず常時掛ける（macOS の normalize が常時なのと同じ）。

/** 目標 RMS = -16 dBFS（macOS の loudnessGain と同じ）。 */
export const NORM_TARGET_RMS = 0.158;
/** 測定ゲート = -42 dBFS。これ未満の窓は「無音／ノイズ床」として測定に含めない。 */
export const NORM_GATE_RMS = 0.0079;
/** ゲインのクランプ = ±18 dB（macOS と同じ）。 */
export const NORM_MIN_GAIN = 0.125;
export const NORM_MAX_GAIN = 8.0;
/** 実質デジタル無音（-74 dBFS 未満）は素通し（ノイズを増幅するだけなので）。 */
export const NORM_SILENCE_RMS = 0.0002;
/** これだけ有音を蓄積するまでゲインを動かさない（冒頭の一瞬で暴れないため）。 */
export const NORM_WARMUP_SEC = 1.5;
/**
 * ゲート超えが溜まらないまま、これだけ経過したらゲート無しで測り直す（macOS と同じ救済）。
 * 出力音量を絞りすぎて素材全体が -42 dBFS を下回ると、ゲート測定では 1 秒も溜まらず
 * 「一番救済が要る素材ほど無補正」になる。ウォームアップより十分長く取り、通常の会話で
 * こちらが先に発火しないようにする。
 */
export const NORM_FALLBACK_SEC = 10;
/** 収束の時定数（秒）。目標自体が累積で安定するので、耳に付かない速さで寄せれば足りる。 */
export const NORM_TAU_SEC = 1.0;

export interface NormalizerState {
  /** 現在の静的ゲイン（線形）。 */
  gain: number;
  /** ゲートを超えた窓の Σ(rms²·dt) と合計秒数。 */
  gatedEnergy: number;
  gatedSec: number;
  /** 全窓の Σ(rms²·dt) と合計秒数（全部ゲート未満だったときのフォールバック用）。 */
  allEnergy: number;
  allSec: number;
}

export function initialNormalizerState(): NormalizerState {
  return { gain: 1, gatedEnergy: 0, gatedSec: 0, allEnergy: 0, allSec: 0 };
}

/**
 * 1 tick 進めた次の状態を返す（純関数・状態は書き換えない）。
 * @param rms **AGC 適用後**のチャンク RMS（0..1）。macOS の normalize が「AGC 済みの録音
 *            ファイル」を測るのと同じ位置で測るため、測定点は AGC の後ろに置く。
 */
export function nextNormalizerState(
  rms: number,
  prev: NormalizerState,
  dtSec: number
): NormalizerState {
  const next: NormalizerState = {
    gain: prev.gain,
    gatedEnergy: prev.gatedEnergy,
    gatedSec: prev.gatedSec,
    allEnergy: prev.allEnergy + rms * rms * dtSec,
    allSec: prev.allSec + dtSec,
  };
  if (rms > NORM_GATE_RMS) {
    next.gatedEnergy += rms * rms * dtSec;
    next.gatedSec += dtSec;
  }
  // 測定値を決める。原則はゲート済み（無音・ノイズ床を測定に含めない）。
  let measured: number;
  if (next.gatedSec >= NORM_WARMUP_SEC) {
    measured = Math.sqrt(next.gatedEnergy / next.gatedSec);
  } else if (next.allSec >= NORM_FALLBACK_SEC) {
    // 救済: ゲート超えが溜まらない＝素材全体が -42 dBFS 未満。出力音量を絞りすぎた場合が
    // これに当たる。ゲート無しで測り直して持ち上げる（macOS の loudnessGain と同じ）。
    measured = Math.sqrt(next.allEnergy / next.allSec);
    if (measured < NORM_SILENCE_RMS) return next; // 実質デジタル無音は素通し
  } else {
    return next; // まだ判断材料が足りない＝ゲインを動かさない
  }
  const desired = Math.min(Math.max(NORM_TARGET_RMS / measured, NORM_MIN_GAIN), NORM_MAX_GAIN);
  next.gain = prev.gain + (desired - prev.gain) * (1 - Math.exp(-dtSec / NORM_TAU_SEC));
  return next;
}

/** 時間領域サンプル列の RMS（0..1）。 */
export function rmsOf(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}
