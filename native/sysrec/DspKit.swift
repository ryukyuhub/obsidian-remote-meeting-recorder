// DspKit.swift — レベル処理 DSP の一枚板（リファクタ調査 R5 で sysrec.swift から分割）。
//
// ここにあるのは「音をどう補正するか」だけ: AGC / 手動ゲイン / リミッター / ノイズゲート /
// 仕上げ正規化（loudnessGain）とその仕様定数（NormSpec）。デバイスやファイル I/O には依存しない。
// 定数は TypeScript 側（src/recorder/agc.ts）と二重実装であり、`sysrec dsp-spec` の申告を
// E2E の契約テストが突き合わせて一致を保証する（設計書 §4.5）。
import AVFoundation
import Foundation

/// 仕上げ正規化の仕様定数（loudnessGain と `dsp-spec` の共有・単一の真実の源）。
/// TypeScript 側（src/recorder/agc.ts の NORM_*）と一致していることを
/// E2E の契約テストが `sysrec dsp-spec` 経由で検証する。値を変えるときは両方直すこと。
enum NormSpec {
    static let targetRMS: Float = 0.158   // -16 dBFS
    static let gateRMS: Float = 0.0079    // -42 dBFS（測定ゲート）
    static let minGain: Float = 0.125     // -18 dB
    static let maxGain: Float = 8.0       // +18 dB
    static let silenceRMS: Float = 0.0002 // -74 dBFS 未満は素通し
    static let ceiling: Float = 0.891     // 仕上げリミッターのシーリング（-1 dBFS）
}

// ============================================================
// レベル処理 DSP（AGC / リミッター）
// ============================================================

/// ストリーミング AGC（自動レベル調整）。1 ソースぶんの状態を持ち、録音時は
/// キャプチャチャンクごと、ミックス時はトラックをチャンク分割して同じ実装を通す。
/// チャンク RMS が無音ゲートを超えるときだけ目標 RMS へ向けてゲインを適応させる
/// （上げはゆっくり・下げは速く）。ゲイン変更はチャンク内で線形ランプしジッパーノイズを避ける。
///
/// ゲート/最大ゲイン（Issue: both+AGC でノイズが持ち上がる件の対策）:
///   - gateRMS はノイズ床より十分上（-42 dBFS）に置く。室内ノイズやデジタル残留（-45〜-55 dBFS）を
///     「有音」と誤認して増幅しないため。以前の -55 dBFS はノイズ床すら超えてしまい、無音のはずが
///     ノイズを +18 dB 持ち上げてしまっていた。
///   - maxGain は +12 dB に抑える（+18 dB は小声を持ち上げる一方でノイズも過大に増幅する）。
///   - ゲート未満（無音/ノイズ床）ではゲインを保持せず 1.0 へ戻し、無音区間でノイズが膨らむ
///     「ポンピング」を防ぐ。ほぼ戻ったら次の有音で即追従できるよう再アームする。
final class AGCProcessor {
    static let targetRMS: Float = 0.1        // -20 dBFS
    static let gateRMS: Float = 0.0079       // -42 dBFS 未満は無音/ノイズ床とみなし増幅しない
    static let minGain: Float = 0.125        // -18 dB（過大入力の抑え）
    static let maxGain: Float = 4.0          // +12 dB（小声の持ち上げとノイズ増幅のバランス）
    private var gain: Float = 1.0
    private var locked = false               // 最初の有音チャンクで即時追従済みか

    /// channels[c] を先頭とする stride 間隔の Float 列に in-place 適用する
    /// （planar は stride=1、interleaved は stride=チャンネル数）。
    func process(_ channels: [UnsafeMutablePointer<Float>], frames: Int, stride: Int, sampleRate: Double) {
        guard frames > 0, !channels.isEmpty else { return }
        var sum: Float = 0
        for ch in channels {
            var idx = 0
            for _ in 0..<frames { let v = ch[idx]; sum += v * v; idx += stride }
        }
        let rms = (sum / Float(frames * channels.count)).squareRoot()
        let prev = gain
        let dt = Double(frames) / sampleRate
        if rms > Self.gateRMS {
            let desired = min(max(Self.targetRMS / rms, Self.minGain), Self.maxGain)
            if !locked {
                gain = desired; locked = true   // 冒頭だけ即追従（数秒無音のままにしない）
            } else {
                let tau = desired < gain ? 0.4 : 3.0
                gain += (desired - gain) * Float(1 - exp(-dt / tau))
            }
        } else {
            // 無音/ノイズ床: ブーストを保持せずゲインを 1.0 へ戻す（無音でノイズを持ち上げない）。
            gain += (1.0 - gain) * Float(1 - exp(-dt / 0.8))
            if abs(gain - 1.0) < 0.05 { gain = 1.0; locked = false } // ほぼ戻ったら即追従を再アーム
        }
        let dg = (gain - prev) / Float(frames)
        for ch in channels {
            var g = prev
            var idx = 0
            for _ in 0..<frames { ch[idx] *= g; g += dg; idx += stride }
        }
    }
}

/// 手動ミキサー用のソース別ゲイン（リアルタイム・ミキサー）。
/// target は外部（control ファイルのポーリング）から dB で設定し、process() はチャンク内で
/// current→target を線形ランプして乗算する（急変のジッパーノイズを避ける）。適用後の RMS を
/// 返し、メーター表示に使う。setTargetDb は timer スレッド、process は音声コールバックから
/// 呼ばれ得るため lock で target を保護する。
final class ManualGain {
    private let lock = NSLock()
    private var target: Float
    private var current: Float

    init(db: Double) { let g = ManualGain.linear(db); target = g; current = g }

    static func linear(_ db: Double) -> Float { Float(pow(10.0, db / 20.0)) }

    func setTargetDb(_ db: Double) {
        let g = ManualGain.linear(db)
        lock.lock(); target = g; lock.unlock()
    }

    /// interleaved 前提の channels（先頭が各チャンネル・stride 間隔）へゲインをランプ乗算し、
    /// 適用後の RMS(0..1) を返す。
    @discardableResult
    func process(_ channels: [UnsafeMutablePointer<Float>], frames: Int, stride: Int) -> Float {
        guard frames > 0, !channels.isEmpty else { return 0 }
        lock.lock(); let tgt = target; lock.unlock()
        let start = current
        let dg = (tgt - start) / Float(frames)
        var sumSq: Float = 0
        for ch in channels {
            var g = start
            var idx = 0
            for _ in 0..<frames {
                let v = ch[idx] * g
                ch[idx] = v
                sumSq += v * v
                g += dg
                idx += stride
            }
        }
        current = tgt
        return (sumSq / Float(frames * channels.count)).squareRoot()
    }
}

/// ストリーミング簡易リミッター（先読みなし・即時アタック / 約100ms リリース）。
/// 録音時の AGC 後段で ±ceiling を超えるピークを抑える最終安全弁。
final class StreamingLimiter {
    static let ceiling: Float = 0.97
    private var g: Float = 1.0

    func process(_ channels: [UnsafeMutablePointer<Float>], frames: Int, stride: Int, sampleRate: Double) {
        guard frames > 0, !channels.isEmpty else { return }
        let rel = Float(1 - exp(-1.0 / (0.1 * sampleRate)))
        var idx = 0
        for _ in 0..<frames {
            var peak: Float = 0
            for ch in channels { let a = abs(ch[idx]); if a > peak { peak = a } }
            if peak * g > Self.ceiling { g = Self.ceiling / peak } else { g += (1 - g) * rel }
            for ch in channels {
                var v = ch[idx] * g
                if v > 1 { v = 1 } else if v < -1 { v = -1 }
                ch[idx] = v
            }
            idx += stride
        }
    }
}

/// 最終ラウドネス正規化のゲイン（-16 dBFS 目標・0.125〜8.0＝±18 dB クランプ）。
/// 400ms 窓の RMS を -42 dBFS でゲートして測る（無音/ノイズ床の窓を測定に含めないため）。
///
/// フォールバック（Issue #4）: 全窓がゲート未満＝素材全体が極小レベルのときは、
/// 以前は「正規化しない」で終わっていた。AutoGain オフ／手動ミキサーはどこにも
/// ゲイン補正が掛からないため、一番救済が要る素材ほど無補正で出る状態だった。
/// そこでゲート無しの全体 RMS で測り直して持ち上げる。ただし実質デジタル無音
/// （-74 dBFS 未満）はノイズを増幅するだけなので素通しする。
func loudnessGain(_ buf: AVAudioPCMBuffer) -> Float {
    let targetLoudRMS = NormSpec.targetRMS
    let win = 19200                    // 400ms @48k
    let gateRMS = NormSpec.gateRMS
    let frames = Int(buf.frameLength)
    let chCount = Int(buf.format.channelCount)
    guard frames > 0, chCount > 0, let data = buf.floatChannelData else { return 1 }
    let st = buf.stride

    var gatedEnergy: Double = 0        // ゲートを超えた窓のみ
    var counted = 0
    var allEnergy: Double = 0          // 全窓（フォールバック用）
    var pos = 0
    while pos < frames {
        let nn = min(win, frames - pos)
        var sum: Float = 0
        for c in 0..<chCount {
            let p = data[c]
            for i in pos..<(pos + nn) { let v = p[i * st]; sum += v * v }
        }
        let rms = (sum / Float(nn * chCount)).squareRoot()
        allEnergy += Double(rms * rms) * Double(nn)
        if rms > gateRMS { gatedEnergy += Double(rms * rms) * Double(nn); counted += nn }
        pos += nn
    }

    let rms: Float
    if counted > 0 {
        rms = Float((gatedEnergy / Double(counted)).squareRoot())
    } else {
        rms = Float((allEnergy / Double(frames)).squareRoot())
        if rms < NormSpec.silenceRMS { return 1 }   // -74 dBFS 未満＝実質デジタル無音
    }
    guard rms > 0 else { return 1 }
    return min(max(targetLoudRMS / rms, NormSpec.minGain), NormSpec.maxGain)
}

/// バッファ全体へ静的ゲインを掛ける（正規化の適用）。
func applyStaticGain(_ buf: AVAudioPCMBuffer, _ g: Float) {
    let frames = Int(buf.frameLength)
    let chCount = Int(buf.format.channelCount)
    guard frames > 0, chCount > 0, let data = buf.floatChannelData else { return }
    let st = buf.stride
    for c in 0..<chCount {
        let p = data[c]
        for i in 0..<frames { p[i * st] *= g }
    }
}

/// オフライン・ルックアヘッドリミッター（ミックス最終段）。5ms 先読みの
/// スライディング最小値（単調キュー）で必要ゲインを先取りし、クリックなしで
/// ピークを ceiling 以下へ抑える。リリース約 50ms。
func applyLookaheadLimiter(_ buf: AVAudioPCMBuffer, ceiling: Float, sampleRate: Double) {
    let frames = Int(buf.frameLength)
    let chCount = Int(buf.format.channelCount)
    guard frames > 0, chCount > 0, let data = buf.floatChannelData else { return }
    let st = buf.stride
    let look = max(1, Int(sampleRate * 0.005))
    let attack = Float(1 - exp(-1.0 / (0.0015 * sampleRate)))
    let release = Float(1 - exp(-1.0 / (0.05 * sampleRate)))

    func desiredGain(_ i: Int) -> Float {
        var p: Float = 0
        for c in 0..<chCount { let a = abs(data[c][i * st]); if a > p { p = a } }
        return p > ceiling ? ceiling / p : 1
    }

    var deque: [(idx: Int, val: Float)] = []   // val 昇順の単調キュー
    var head = 0
    var pushed = -1
    // 初期ゲインは先頭ウィンドウの必要値に合わせる（冒頭から過大入力でも漏らさない）
    var g: Float = 1.0
    for j in 0...min(look, frames - 1) { g = min(g, desiredGain(j)) }
    for i in 0..<frames {
        while pushed < min(i + look, frames - 1) {
            pushed += 1
            let d = desiredGain(pushed)
            while deque.count > head, deque[deque.count - 1].val >= d { deque.removeLast() }
            deque.append((pushed, d))
        }
        while deque.count > head, deque[head].idx < i { head += 1 }
        if head > 4096 { deque.removeFirst(head); head = 0 }
        let dmin = deque.count > head ? deque[head].val : 1
        g += (dmin - g) * (dmin < g ? attack : release)
        for c in 0..<chCount {
            var v = data[c][i * st] * g
            if v > 0.985 { v = 0.985 } else if v < -0.985 { v = -0.985 }
            data[c][i * st] = v
        }
    }
}

/// サンプルレートに比例して AAC ビットレート(bps)を決める。
/// 48000Hz で base、下げるほど小さくする（帯域が狭いので低ビットレートで十分）。下限 32kbps。
/// M4A(AAC) のファイルサイズはビットレートで決まるため、これでサンプルレートを下げると
/// ファイルサイズも実際に小さくなる（既定 48000Hz では従来どおりの値を保つ）。
func scaledBitrate(_ base: Int, sampleRate: Int) -> Int {
    let sr = sampleRate > 0 ? sampleRate : 48000
    let v = Int((Double(base) * Double(sr) / 48000.0).rounded())
    return max(32000, v)
}

/// ノイズゲート（マイク用・AGC 有効時）。入力 RMS が閾値未満（＝無音/環境ノイズ）のとき
/// 出力ゲインを floor（ほぼ 0）へ落として録音レベルを著しく下げる。閾値超えで素早く開き、
/// 有音が hold を超えて途切れたら緩やかに閉じる（語尾切れ・チャタリングを避ける）。
/// 判定は AGC で持ち上げる前の生入力 RMS で行う（AGC と綱引きしないため）。
final class NoiseGate {
    static let floor: Float = 0.0        // 閉時ゲイン（0＝ほぼ無音）
    static let holdSec: Double = 0.2     // 有音が途切れても開けておく保持時間
    private let openRMS: Float           // これ以上を「有音」とみなして開く（閾値・可変）
    private var gain: Float = 1.0
    private var hold: Double = 0

    /// thresholdDb（例 -40 dBFS）以上を有音とみなす。閾値は設定で選べる。
    init(thresholdDb: Double) { openRMS = Float(pow(10.0, thresholdDb / 20.0)) }

    /// AGC/リミッター適用後の channels に、生入力 RMS で判定したゲートゲインをランプ乗算する。
    func process(_ channels: [UnsafeMutablePointer<Float>], frames: Int, stride: Int,
                 sampleRate: Double, inputRMS: Float) {
        guard frames > 0, !channels.isEmpty else { return }
        let dt = Double(frames) / sampleRate
        if inputRMS >= openRMS { hold = Self.holdSec } else { hold = max(0, hold - dt) }
        let target: Float = hold > 0 ? 1.0 : Self.floor
        let prev = gain
        let tau = target > gain ? 0.008 : 0.15   // 開:速い(8ms) / 閉:緩やか(150ms)
        gain += (target - gain) * Float(1 - exp(-dt / tau))
        let dg = (gain - prev) / Float(frames)
        for ch in channels {
            var g = prev
            var idx = 0
            for _ in 0..<frames { ch[idx] *= g; g += dg; idx += stride }
        }
    }

    /// interleaved/planar な channels の RMS（ゲート判定用・AGC 前に測る）。
    static func rms(_ channels: [UnsafeMutablePointer<Float>], frames: Int, stride: Int) -> Float {
        guard frames > 0, !channels.isEmpty else { return 0 }
        var sum: Float = 0
        for ch in channels {
            var idx = 0
            for _ in 0..<frames { let v = ch[idx]; sum += v * v; idx += stride }
        }
        return (sum / Float(frames * channels.count)).squareRoot()
    }
}
