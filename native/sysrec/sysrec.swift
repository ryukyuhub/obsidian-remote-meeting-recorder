// sysrec — macOS 会議録音バイナリ（Core Audio プロセスタップ + AVAudioEngine）
//
// 会議録音MCP設計書.md §3.1 / §3.1a の「録音バイナリ共通契約」を実装する。
// システム音声（Core Audio プロセスタップ・AudioHardwareCreateProcessTap, macOS 14.4+）と
// マイク（AVAudioEngine）を取得し、source に応じて .m4a(AAC) で書き出す CLI。
// ScreenCaptureKit を使わないため録音中も「画面録画中」状態にならず、DRM 保護映像
// （Netflix 等）が黒くならない（DRM対策 CoreAudioタップ移行 実装レポート参照）。
//
// 使い方:
//   録音:  sysrec --out <path> [--source both|system|mic] [--mic-device <uid>]
//                 [--samplerate 48000] [--channels 2] [--agc on|off]
//                 [--status-file <path>] [--pidfile <path>]
//   ミックス: sysrec mix --in <a.m4a> --in <b.m4a> --out <out.m4a>
//             [--agc on|off] [--normalize on|off] [--channels 1|2] [--samplerate 48000]
//             （both の 2 ファイルを 1 本へ。ffmpeg 非依存の AVFoundation 実装。
//               --channels 1 で L/R 平均のモノラル出力）
//
// レベル処理:
//   録音時   … ソース別 AGC（自動レベル調整・目標 -20 dBFS）+ 簡易リミッター（--agc off で無効）
//   ミックス … トラック別 AGC → 加算 → ラウドネス正規化（目標 -16 dBFS、--normalize off で無効）
//             → ルックアヘッドリミッター（シーリング -1 dBFS・常時有効）
//
// 停止: SIGINT / SIGTERM、または標準入力に "stop"。
// 終了コード: 0=正常 / 2=権限なし / 3=デバイスなし / 4=ディスク等 / 1=その他

import AVFoundation
import CoreAudio
import AudioToolbox
import Darwin

// ============================================================
// 共通ユーティリティ
// ============================================================

let ISO: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime]
    return f
}()

/// stdout（JSON専用）と --status-file の双方へ1行追記する。
final class Emitter {
    private let statusPath: String?
    private let q = DispatchQueue(label: "sysrec.emit")
    init(statusPath: String?) { self.statusPath = statusPath }

    func emit(_ obj: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]),
              let line = String(data: data, encoding: .utf8) else { return }
        q.sync {
            FileHandle.standardOutput.write(Data((line + "\n").utf8))
            if let p = statusPath {
                if let h = FileHandle(forWritingAtPath: p) {
                    h.seekToEndOfFile(); h.write(Data((line + "\n").utf8)); try? h.close()
                } else {
                    try? (line + "\n").write(toFile: p, atomically: true, encoding: .utf8)
                }
            }
        }
    }
}

func logErr(_ s: String) { FileHandle.standardError.write(Data((s + "\n").utf8)) }

func die(_ code: Int32, _ message: String) -> Never {
    logErr("sysrec: \(message)")
    exit(code)
}

// ============================================================
// 引数
// ============================================================

struct Options {
    var out: String = ""
    var source: String = "both"          // both | system | mic
    var micDevice: String? = nil
    var sampleRate: Int = 48000
    var channels: Int = 2
    var statusFile: String? = nil
    var pidFile: String? = nil
    var agc: Bool = true                 // 録音時の自動レベル調整+リミッター
}

func parseRecordArgs(_ argv: [String]) -> Options {
    var o = Options()
    var i = 0
    func next() -> String { i += 1; return i < argv.count ? argv[i] : "" }
    while i < argv.count {
        switch argv[i] {
        case "--out": o.out = next()
        case "--source": o.source = next()
        case "--mic-device": o.micDevice = next()
        case "--samplerate": o.sampleRate = Int(next()) ?? 48000
        case "--channels": o.channels = Int(next()) ?? 2
        case "--status-file": o.statusFile = next()
        case "--pidfile": o.pidFile = next()
        case "--agc": o.agc = (next() != "off")
        case "--tmp": _ = next() // 予約（現状未使用）
        default: break
        }
        i += 1
    }
    return o
}

// ============================================================
// レベル処理 DSP（AGC / リミッター）
// ============================================================

/// ストリーミング AGC（自動レベル調整）。1 ソースぶんの状態を持ち、録音時は
/// キャプチャチャンクごと、ミックス時はトラックをチャンク分割して同じ実装を通す。
/// チャンク RMS が無音ゲートを超えるときだけ目標 RMS へ向けてゲインを適応させる
/// （上げはゆっくり・下げは速く）。ゲイン変更はチャンク内で線形ランプし
/// ジッパーノイズを避ける。
final class AGCProcessor {
    static let targetRMS: Float = 0.1        // -20 dBFS
    static let gateRMS: Float = 0.0018       // -55 dBFS 未満は無音（ノイズを持ち上げない）
    static let minGain: Float = 0.125        // -18 dB（過大入力の抑え）
    static let maxGain: Float = 8.0          // +18 dB（小声マイクの持ち上げ）
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
        if rms > Self.gateRMS {
            let desired = min(max(Self.targetRMS / rms, Self.minGain), Self.maxGain)
            if !locked {
                gain = desired; locked = true   // 冒頭だけ即追従（数秒無音のままにしない）
            } else {
                let dt = Double(frames) / sampleRate
                let tau = desired < gain ? 0.4 : 3.0
                gain += (desired - gain) * Float(1 - exp(-dt / tau))
            }
        }
        let dg = (gain - prev) / Float(frames)
        for ch in channels {
            var g = prev
            var idx = 0
            for _ in 0..<frames { ch[idx] *= g; g += dg; idx += stride }
        }
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

// ============================================================
// 書き出し（1 ソース = 1 AVAssetWriter）
// ============================================================

/// サンプルレートに比例して AAC ビットレート(bps)を決める。
/// 48000Hz で base、下げるほど小さくする（帯域が狭いので低ビットレートで十分）。下限 32kbps。
/// M4A(AAC) のファイルサイズはビットレートで決まるため、これでサンプルレートを下げると
/// ファイルサイズも実際に小さくなる（既定 48000Hz では従来どおりの値を保つ）。
func scaledBitrate(_ base: Int, sampleRate: Int) -> Int {
    let sr = sampleRate > 0 ? sampleRate : 48000
    let v = Int((Double(base) * Double(sr) / 48000.0).rounded())
    return max(32000, v)
}

/// 1 つの音声ソース（system もしくは microphone）を AAC .m4a へ書き出す箱。
/// 最初のサンプルが届いた時点で実フォーマット(ASBD)からライタを遅延生成する。
/// agc=true なら Float32 PCM チャンクに AGC+リミッターを適用してから書き出す
/// （対象外フォーマットは素通し）。
final class WriterBox {
    let path: String
    let label: String                 // "system" / "microphone"
    private var writer: AVAssetWriter?
    private var input: AVAssetWriterInput?
    private var startPTS: CMTime = .invalid
    private var lastPTS: CMTime = .zero
    private var failed = false
    private let agc: AGCProcessor?
    private let limiter: StreamingLimiter?

    init(path: String, label: String, agc: Bool) {
        self.path = path
        self.label = label
        self.agc = agc ? AGCProcessor() : nil
        self.limiter = agc ? StreamingLimiter() : nil
    }

    /// サンプルバッファを追記する（必要なら初回にライタ生成）。
    func append(_ sb: CMSampleBuffer) {
        guard CMSampleBufferGetNumSamples(sb) > 0 else { return }
        if writer == nil { setup(with: sb) }
        guard let input, !failed else { return }
        let toWrite = processed(sb) ?? sb
        let pts = CMSampleBufferGetPresentationTimeStamp(sb)
        if input.isReadyForMoreMediaData {
            if input.append(toWrite) { lastPTS = pts }
        }
    }

    /// AGC+リミッターを適用した新しい CMSampleBuffer を返す。AGC 無効・
    /// Float32 LPCM 以外・変換失敗時は nil（呼び出し側が元バッファを使う）。
    /// ABL の取得は withAudioBufferList を使う（手動の
    /// CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer 直呼びはサイズ厳格化で
    /// -12737 を返すことがある）。取り出した blockBuffer は元バッファと同一メモリとは
    /// 限らないため、加工後は必ず新しい CMSampleBuffer に包み直して返す。
    private func processed(_ sb: CMSampleBuffer) -> CMSampleBuffer? {
        guard let agc, let limiter,
              let fmt = CMSampleBufferGetFormatDescription(sb),
              let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(fmt)?.pointee,
              asbd.mFormatID == kAudioFormatLinearPCM,
              asbd.mFormatFlags & kAudioFormatFlagIsFloat != 0,
              asbd.mBitsPerChannel == 32 else { return nil }
        let frames = CMSampleBufferGetNumSamples(sb)
        guard frames > 0 else { return nil }
        let sr = asbd.mSampleRate > 0 ? asbd.mSampleRate : 48000
        do {
            return try sb.withAudioBufferList(blockBufferMemoryAllocator: kCFAllocatorDefault) {
                abl, blockBuf -> CMSampleBuffer? in
                var chans: [UnsafeMutablePointer<Float>] = []
                var stride = 1
                if abl.count == 1 {
                    guard let base = abl[0].mData?.assumingMemoryBound(to: Float.self) else { return nil }
                    let c = max(1, Int(abl[0].mNumberChannels))
                    stride = c
                    for ch in 0..<c { chans.append(base + ch) }
                } else {
                    for b in abl {
                        guard let p = b.mData?.assumingMemoryBound(to: Float.self) else { return nil }
                        chans.append(p)
                    }
                }
                agc.process(chans, frames: frames, stride: stride, sampleRate: sr)
                limiter.process(chans, frames: frames, stride: stride, sampleRate: sr)

                var timing = CMSampleTimingInfo(
                    duration: CMTime(value: 1, timescale: CMTimeScale(sr)),
                    presentationTimeStamp: CMSampleBufferGetPresentationTimeStamp(sb),
                    decodeTimeStamp: .invalid)
                var newSB: CMSampleBuffer?
                guard CMSampleBufferCreate(
                    allocator: kCFAllocatorDefault, dataBuffer: blockBuf, dataReady: true,
                    makeDataReadyCallback: nil, refcon: nil, formatDescription: fmt,
                    sampleCount: frames, sampleTimingEntryCount: 1, sampleTimingArray: &timing,
                    sampleSizeEntryCount: 0, sampleSizeArray: nil, sampleBufferOut: &newSB) == noErr
                else { return nil }
                return newSB
            }
        } catch {
            return nil
        }
    }

    private func setup(with sb: CMSampleBuffer) {
        let url = URL(fileURLWithPath: path)
        try? FileManager.default.removeItem(at: url)
        guard let fmt = CMSampleBufferGetFormatDescription(sb),
              let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(fmt)?.pointee else {
            failed = true; return
        }
        let srOut = asbd.mSampleRate > 0 ? asbd.mSampleRate : 48000
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: srOut,
            AVNumberOfChannelsKey: Int(asbd.mChannelsPerFrame) > 0 ? Int(asbd.mChannelsPerFrame) : 2,
            AVEncoderBitRateKey: scaledBitrate(128000, sampleRate: Int(srOut)),
        ]
        do {
            let w = try AVAssetWriter(outputURL: url, fileType: .m4a)
            let inp = AVAssetWriterInput(mediaType: .audio, outputSettings: settings)
            inp.expectsMediaDataInRealTime = true
            guard w.canAdd(inp) else { failed = true; return }
            w.add(inp)
            guard w.startWriting() else { failed = true; return }
            let pts = CMSampleBufferGetPresentationTimeStamp(sb)
            w.startSession(atSourceTime: pts)
            startPTS = pts; lastPTS = pts
            writer = w; input = inp
        } catch {
            logErr("writer setup failed (\(label)): \(error)")
            failed = true
        }
    }

    /// finalize。durationSec と bytes を返す。
    func finish() -> (durationSec: Double, bytes: Int64) {
        guard let writer, let input else { return (0, 0) }
        input.markAsFinished()
        let sem = DispatchSemaphore(value: 0)
        writer.finishWriting { sem.signal() }
        sem.wait()
        var dur = 0.0
        if startPTS.isValid { dur = max(0, CMTimeGetSeconds(CMTimeSubtract(lastPTS, startPTS))) }
        let attrs = try? FileManager.default.attributesOfItem(atPath: path)
        let bytes = (attrs?[.size] as? Int64) ?? 0
        return (dur, bytes)
    }
}

// ============================================================
// キャプチャ本体（Core Audio プロセスタップ + AVAudioEngine）
// system=タップ / mic=AVAudioEngine。両者を目標フォーマット（--samplerate/--channels）へ
// 正規化して WriterBox へ渡すので、下流（WriterBox/AGC/mix）は SCK 時代のまま流用できる。
// ============================================================

enum CaptureError: Error { case msg(String) }

/// AVAudioPCMBuffer(Float32) を、指定 PTS 付きの CMSampleBuffer に包む。
/// WriterBox が期待する「Float32 LPCM の CMSampleBuffer」を作る（AGC 経路も通る）。
func makeAudioSampleBuffer(from pcm: AVAudioPCMBuffer, pts: CMTime) -> CMSampleBuffer? {
    let frames = CMItemCount(pcm.frameLength)
    guard frames > 0 else { return nil }
    var asbd = pcm.format.streamDescription.pointee
    var formatDesc: CMFormatDescription?
    guard CMAudioFormatDescriptionCreate(
        allocator: kCFAllocatorDefault, asbd: &asbd,
        layoutSize: 0, layout: nil, magicCookieSize: 0, magicCookie: nil,
        extensions: nil, formatDescriptionOut: &formatDesc) == noErr,
        let formatDesc else { return nil }
    let sr = asbd.mSampleRate > 0 ? asbd.mSampleRate : 48000
    var timing = CMSampleTimingInfo(
        duration: CMTime(value: 1, timescale: CMTimeScale(sr)),
        presentationTimeStamp: pts, decodeTimeStamp: .invalid)
    var sb: CMSampleBuffer?
    guard CMSampleBufferCreate(
        allocator: kCFAllocatorDefault, dataBuffer: nil, dataReady: false,
        makeDataReadyCallback: nil, refcon: nil, formatDescription: formatDesc,
        sampleCount: frames, sampleTimingEntryCount: 1, sampleTimingArray: &timing,
        sampleSizeEntryCount: 0, sampleSizeArray: nil, sampleBufferOut: &sb) == noErr,
        let sb else { return nil }
    guard CMSampleBufferSetDataBufferFromAudioBufferList(
        sb, blockBufferAllocator: kCFAllocatorDefault,
        blockBufferMemoryAllocator: kCFAllocatorDefault,
        flags: 0, bufferList: pcm.audioBufferList) == noErr else { return nil }
    return sb
}

/// 入力フォーマットを目標（sampleRate/channels・Float32・interleaved）へ変換する。
/// 目標と同一なら素通し。SCK 時代は cfg.sampleRate/channelCount で目標形式を直接得ていたので、
/// タップ/エンジンの native 形式をここで揃えて下流の挙動を不変にする。
final class FormatNormalizer {
    let targetFormat: AVAudioFormat
    private let converter: AVAudioConverter?
    init?(from src: AVAudioFormat, sampleRate: Double, channels: AVAudioChannelCount) {
        guard let target = AVAudioFormat(
            commonFormat: .pcmFormatFloat32, sampleRate: sampleRate,
            channels: channels, interleaved: true) else { return nil }
        targetFormat = target
        if src.sampleRate == target.sampleRate && src.channelCount == target.channelCount {
            converter = nil
        } else {
            converter = AVAudioConverter(from: src, to: target)
        }
    }
    func convert(_ input: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
        guard let converter else { return input } // 同一フォーマット＝素通し
        let ratio = targetFormat.sampleRate / input.format.sampleRate
        let cap = AVAudioFrameCount(Double(input.frameLength) * ratio) + 32
        guard let out = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: cap) else { return nil }
        var supplied = false
        var err: NSError?
        let status = converter.convert(to: out, error: &err) { _, outStatus in
            if supplied { outStatus.pointee = .noDataNow; return nil }
            supplied = true; outStatus.pointee = .haveData; return input
        }
        if status == .error || out.frameLength == 0 { return nil }
        return out
    }
}

/// 生の AudioBufferList(interleaved Float32) を AVAudioPCMBuffer にコピーする。
/// タップ IOProc が渡すバッファはコールバック内でのみ有効なので、必ずコピーして持ち出す。
func copyToPCMBuffer(_ abl: UnsafeMutableAudioBufferListPointer, format: AVAudioFormat,
                     frames: AVAudioFrameCount) -> AVAudioPCMBuffer? {
    guard frames > 0, abl.count >= 1,
          let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames) else { return nil }
    out.frameLength = frames
    let dst = UnsafeMutableAudioBufferListPointer(out.mutableAudioBufferList)
    guard let srcData = abl[0].mData, let dstData = dst[0].mData else { return nil }
    let bytes = min(Int(abl[0].mDataByteSize), Int(dst[0].mDataByteSize))
    memcpy(dstData, srcData, bytes)
    dst[0].mDataByteSize = UInt32(bytes)
    return out
}

/// UID からオーディオ入力デバイス ID を引く（--mic-device 用・best-effort）。
func audioDeviceID(forUID uid: String) -> AudioDeviceID? {
    let sys = AudioObjectID(kAudioObjectSystemObject)
    var size = UInt32(0)
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDevices,
        mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    guard AudioObjectGetPropertyDataSize(sys, &addr, 0, nil, &size) == noErr, size > 0 else { return nil }
    let count = Int(size) / MemoryLayout<AudioDeviceID>.size
    var ids = [AudioDeviceID](repeating: 0, count: count)
    guard AudioObjectGetPropertyData(sys, &addr, 0, nil, &size, &ids) == noErr else { return nil }
    for id in ids {
        var uidRef: Unmanaged<CFString>?
        var usz = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        var uaddr = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyDeviceUID,
            mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        if AudioObjectGetPropertyData(id, &uaddr, 0, nil, &usz, &uidRef) == noErr,
           let v = uidRef?.takeRetainedValue(), (v as String) == uid {
            return id
        }
    }
    return nil
}

/// システム音声を Core Audio プロセスタップで取得（画面キャプチャなし）。onBuffer に native PCM を渡す。
final class TapCapturer {
    private let onBuffer: (AVAudioPCMBuffer) -> Void
    private var tapID = AudioObjectID(kAudioObjectUnknown)
    private var aggID = AudioObjectID(kAudioObjectUnknown)
    private var ioProc: AudioDeviceIOProcID?
    private var srcFormat: AVAudioFormat?

    init(onBuffer: @escaping (AVAudioPCMBuffer) -> Void) { self.onBuffer = onBuffer }

    func start() throws {
        let sys = AudioObjectID(kAudioObjectSystemObject)
        // 自プロセス除外つき・非ミュートの全体タップ（実出力はミュートしない＝ユーザは音を聞ける）
        var pid = getpid()
        var ownObj = AudioObjectID(kAudioObjectUnknown)
        var oaddr = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyTranslatePIDToProcessObject,
            mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var osz = UInt32(MemoryLayout<AudioObjectID>.size)
        _ = AudioObjectGetPropertyData(sys, &oaddr, UInt32(MemoryLayout<pid_t>.size), &pid, &osz, &ownObj)
        let desc = CATapDescription(stereoGlobalTapButExcludeProcesses: ownObj != 0 ? [ownObj] : [])
        desc.name = "sysrec system tap"
        desc.isPrivate = true
        desc.muteBehavior = .unmuted

        guard AudioHardwareCreateProcessTap(desc, &tapID) == noErr, tapID != 0 else {
            throw CaptureError.msg("システム音声タップを作成できませんでした（オーディオ録音の権限を確認してください）。")
        }
        var asbd = AudioStreamBasicDescription()
        var asz = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        var faddr = AudioObjectPropertyAddress(
            mSelector: kAudioTapPropertyFormat,
            mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        guard AudioObjectGetPropertyData(tapID, &faddr, 0, nil, &asz, &asbd) == noErr,
              let fmt = AVAudioFormat(streamDescription: &asbd) else {
            AudioHardwareDestroyProcessTap(tapID)
            throw CaptureError.msg("タップの音声フォーマットを取得できませんでした。")
        }
        srcFormat = fmt

        guard let outUID = TapCapturer.defaultOutputUID() else {
            AudioHardwareDestroyProcessTap(tapID)
            throw CaptureError.msg("デフォルト出力デバイスを取得できませんでした。")
        }
        let aggDesc: [String: Any] = [
            kAudioAggregateDeviceNameKey as String: "sysrec aggregate",
            kAudioAggregateDeviceUIDKey as String: "sysrec-agg-\(getpid())",
            kAudioAggregateDeviceMainSubDeviceKey as String: outUID,
            kAudioAggregateDeviceIsPrivateKey as String: true,
            kAudioAggregateDeviceIsStackedKey as String: false,
            kAudioAggregateDeviceSubDeviceListKey as String: [[kAudioSubDeviceUIDKey as String: outUID]],
            kAudioAggregateDeviceTapListKey as String: [[
                kAudioSubTapUIDKey as String: desc.uuid.uuidString,
                kAudioSubTapDriftCompensationKey as String: true,
            ]],
        ]
        guard AudioHardwareCreateAggregateDevice(aggDesc as CFDictionary, &aggID) == noErr, aggID != 0 else {
            AudioHardwareDestroyProcessTap(tapID)
            throw CaptureError.msg("集約デバイスを作成できませんでした。")
        }

        let block: AudioDeviceIOBlock = { [weak self] _, inInputData, _, _, _ in
            guard let self, let fmt = self.srcFormat else { return }
            let abl = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: inInputData))
            guard abl.count >= 1, abl[0].mData != nil else { return }
            let ch = max(1, Int(abl[0].mNumberChannels))
            let frames = AVAudioFrameCount(Int(abl[0].mDataByteSize) / (MemoryLayout<Float>.size * ch))
            guard frames > 0, let pcm = copyToPCMBuffer(abl, format: fmt, frames: frames) else { return }
            self.onBuffer(pcm)
        }
        guard AudioDeviceCreateIOProcIDWithBlock(&ioProc, aggID, nil, block) == noErr, let proc = ioProc else {
            AudioHardwareDestroyAggregateDevice(aggID); AudioHardwareDestroyProcessTap(tapID)
            throw CaptureError.msg("IOProc を作成できませんでした。")
        }
        guard AudioDeviceStart(aggID, proc) == noErr else {
            AudioDeviceDestroyIOProcID(aggID, proc)
            AudioHardwareDestroyAggregateDevice(aggID); AudioHardwareDestroyProcessTap(tapID)
            throw CaptureError.msg("システム音声タップを開始できませんでした。")
        }
    }

    /// 停止/破棄は順序厳守（Stop → DestroyIOProcID → DestroyAggregate → DestroyProcessTap）。
    func stop() {
        if let proc = ioProc {
            AudioDeviceStop(aggID, proc)
            AudioDeviceDestroyIOProcID(aggID, proc)
            ioProc = nil
        }
        if aggID != 0 { AudioHardwareDestroyAggregateDevice(aggID); aggID = 0 }
        if tapID != 0 { AudioHardwareDestroyProcessTap(tapID); tapID = 0 }
    }

    private static func defaultOutputUID() -> String? {
        let sys = AudioObjectID(kAudioObjectSystemObject)
        var dev = AudioObjectID(kAudioObjectUnknown)
        var sz = UInt32(MemoryLayout<AudioObjectID>.size)
        var a1 = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultOutputDevice,
            mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        guard AudioObjectGetPropertyData(sys, &a1, 0, nil, &sz, &dev) == noErr, dev != 0 else { return nil }
        var uid: Unmanaged<CFString>?
        var usz = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        var a2 = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyDeviceUID,
            mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        guard AudioObjectGetPropertyData(dev, &a2, 0, nil, &usz, &uid) == noErr,
              let v = uid?.takeRetainedValue() else { return nil }
        return v as String
    }
}

/// マイクを AVAudioEngine で取得。onBuffer に native PCM を渡す。
final class MicCapturer {
    private let engine = AVAudioEngine()
    private let onBuffer: (AVAudioPCMBuffer) -> Void
    private var installed = false
    init(onBuffer: @escaping (AVAudioPCMBuffer) -> Void) { self.onBuffer = onBuffer }

    func start(micDevice: String?) throws {
        let input = engine.inputNode
        // 特定マイク指定（best-effort）。解決できなければ既定入力にフォールバック。
        if let uid = micDevice, let devID = audioDeviceID(forUID: uid), let unit = input.audioUnit {
            var dev = devID
            let st = AudioUnitSetProperty(unit, kAudioOutputUnitProperty_CurrentDevice,
                                          kAudioUnitScope_Global, 0, &dev,
                                          UInt32(MemoryLayout<AudioDeviceID>.size))
            if st != noErr { logErr("マイクデバイス指定に失敗（既定入力を使用）: \(st)") }
        }
        let format = input.outputFormat(forBus: 0)
        guard format.channelCount > 0, format.sampleRate > 0 else {
            throw CaptureError.msg("マイク入力フォーマットが不正です（入力デバイスを確認してください）。")
        }
        input.installTap(onBus: 0, bufferSize: 4096, format: format) { [weak self] buf, _ in
            self?.onBuffer(buf)
        }
        installed = true
        engine.prepare()
        do { try engine.start() } catch {
            input.removeTap(onBus: 0); installed = false
            throw CaptureError.msg("マイクを開始できませんでした: \(error.localizedDescription)")
        }
    }

    func stop() {
        if installed { engine.inputNode.removeTap(onBus: 0); installed = false }
        engine.stop()
    }
}

final class Capture {
    private let opt: Options
    private let emitter: Emitter
    private var sysBox: WriterBox?
    private var micBox: WriterBox?
    private var tap: TapCapturer?
    private var mic: MicCapturer?
    private var sysNorm: FormatNormalizer?
    private var micNorm: FormatNormalizer?
    private var sysFrames: Int64 = 0
    private var micFrames: Int64 = 0
    private var stopping = false
    private let stopLock = NSLock()

    init(_ opt: Options, _ emitter: Emitter) {
        self.opt = opt; self.emitter = emitter
        // 出力先パスの用意（both は中間 2 ファイル）
        if opt.source == "both" {
            let base = (opt.out as NSString).deletingPathExtension
            sysBox = WriterBox(path: base + ".sys.m4a", label: "system", agc: opt.agc)
            micBox = WriterBox(path: base + ".mic.m4a", label: "microphone", agc: opt.agc)
        } else if opt.source == "system" {
            sysBox = WriterBox(path: opt.out, label: "system", agc: opt.agc)
        } else { // mic
            micBox = WriterBox(path: opt.out, label: "microphone", agc: opt.agc)
        }
    }

    func start() {
        do {
            if opt.source != "mic" {
                let t = TapCapturer { [weak self] pcm in self?.handleSystem(pcm) }
                try t.start()
                tap = t
            }
            if opt.source != "system" {
                let m = MicCapturer { [weak self] pcm in self?.handleMic(pcm) }
                try m.start(micDevice: opt.micDevice)
                mic = m
            }
        } catch CaptureError.msg(let m) {
            die(2, m)
        } catch {
            die(1, "録音を開始できませんでした: \(error.localizedDescription)")
        }
        emitter.emit([
            "event": "started",
            "source": opt.source,
            "ts": ISO.string(from: Date()),
            "pid": Int(getpid()),
        ])
    }

    // system: タップ由来の PCM を目標フォーマットへ正規化し、連番 PTS で sysBox へ。
    private func handleSystem(_ pcm: AVAudioPCMBuffer) {
        if stopping { return }
        if sysNorm == nil {
            sysNorm = FormatNormalizer(from: pcm.format, sampleRate: Double(opt.sampleRate),
                                       channels: AVAudioChannelCount(max(1, opt.channels)))
        }
        guard let out = sysNorm?.convert(pcm), out.frameLength > 0 else { return }
        let pts = CMTime(value: sysFrames, timescale: CMTimeScale(opt.sampleRate))
        if let sb = makeAudioSampleBuffer(from: out, pts: pts) {
            sysBox?.append(sb); sysFrames += Int64(out.frameLength)
        }
    }

    // mic: エンジン由来の PCM を同様に micBox へ。
    private func handleMic(_ pcm: AVAudioPCMBuffer) {
        if stopping { return }
        if micNorm == nil {
            micNorm = FormatNormalizer(from: pcm.format, sampleRate: Double(opt.sampleRate),
                                       channels: AVAudioChannelCount(max(1, opt.channels)))
        }
        guard let out = micNorm?.convert(pcm), out.frameLength > 0 else { return }
        let pts = CMTime(value: micFrames, timescale: CMTimeScale(opt.sampleRate))
        if let sb = makeAudioSampleBuffer(from: out, pts: pts) {
            micBox?.append(sb); micFrames += Int64(out.frameLength)
        }
    }

    func stop() {
        stopLock.lock()
        if stopping { stopLock.unlock(); return }
        stopping = true
        stopLock.unlock()
        // まずコールバックを止めてから finalize（キャプチャ停止は同期的）。
        tap?.stop()
        mic?.stop()
        finishAndExit(code: 0)
    }

    private func finishAndExit(code: Int32) {
        let sys = sysBox?.finish()
        let mic = micBox?.finish()
        var ev: [String: Any] = ["event": "stopped", "source": opt.source]
        if opt.source == "both" {
            ev["parts"] = ["system": sysBox?.path ?? "", "mic": micBox?.path ?? ""]
            ev["durationSec"] = Int(max(sys?.durationSec ?? 0, mic?.durationSec ?? 0))
        } else {
            let r = sys ?? mic
            ev["path"] = opt.out
            ev["durationSec"] = Int(r?.durationSec ?? 0)
            ev["bytes"] = Int(r?.bytes ?? 0)
        }
        emitter.emit(ev)
        exit(code)
    }
}

// ============================================================
// ミックス（both 2ファイル → 1ファイル。ffmpeg 非依存）
// ============================================================

func runMix(_ argv: [String]) -> Never {
    var inputs: [String] = []
    var out = ""
    var agcOn = true        // トラック別の自動レベル調整
    var normalizeOn = true  // 最終ラウドネス正規化（リミッターは常時有効）
    var outChannels = 2     // 出力チャンネル数（1=モノラル / 2=ステレオ。既定は 2）
    var mixSampleRate = 48000 // 出力ビットレート算出用（設定サンプルレート。出力自体は 48000Hz 固定）
    var i = 0
    while i < argv.count {
        switch argv[i] {
        case "--in": i += 1; if i < argv.count { inputs.append(argv[i]) }
        case "--out": i += 1; if i < argv.count { out = argv[i] }
        case "--agc": i += 1; if i < argv.count { agcOn = (argv[i] != "off") }
        case "--normalize": i += 1; if i < argv.count { normalizeOn = (argv[i] != "off") }
        case "--channels": i += 1; if i < argv.count { outChannels = (Int(argv[i]) == 1) ? 1 : 2 }
        case "--samplerate": i += 1; if i < argv.count { mixSampleRate = Int(argv[i]) ?? 48000 }
        default: break
        }
        i += 1
    }
    guard inputs.count >= 1, !out.isEmpty else { die(1, "mix: --in <file> を1つ以上、--out <file> を指定してください。") }

    let target = AVAudioFormat(standardFormatWithSampleRate: 48000, channels: 2)!

    func load(_ path: String) -> AVAudioPCMBuffer? {
        guard let f = try? AVAudioFile(forReading: URL(fileURLWithPath: path)) else {
            logErr("mix: 読み込み失敗 \(path)"); return nil
        }
        let inFmt = f.processingFormat
        guard f.length > 0,
              let inBuf = AVAudioPCMBuffer(pcmFormat: inFmt, frameCapacity: AVAudioFrameCount(f.length)) else { return nil }
        do { try f.read(into: inBuf) } catch { logErr("mix: read失敗 \(path): \(error)"); return nil }
        if inFmt.sampleRate == target.sampleRate && inFmt.channelCount == target.channelCount
            && inFmt.commonFormat == target.commonFormat { return inBuf }
        guard let conv = AVAudioConverter(from: inFmt, to: target) else { return nil }
        let cap = AVAudioFrameCount(Double(inBuf.frameLength) * target.sampleRate / inFmt.sampleRate) + 4096
        guard let outBuf = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: cap) else { return nil }
        var supplied = false
        var convErr: NSError?
        conv.convert(to: outBuf, error: &convErr) { _, status in
            if supplied { status.pointee = .endOfStream; return nil }
            supplied = true; status.pointee = .haveData; return inBuf
        }
        if let convErr { logErr("mix: 変換失敗 \(path): \(convErr)"); return nil }
        return outBuf
    }

    let buffers = inputs.compactMap { load($0) }
    guard !buffers.isEmpty else { die(1, "mix: 有効な入力がありません。") }

    // 1) トラック別 AGC — 録音時と同じ AGC をチャンク分割で流し、トラック間の
    //    音量差（小声マイク vs 大きいシステム音声）と時間方向の変動を揃える。
    if agcOn {
        let chunk = 4800 // 100ms @48k
        for buf in buffers {
            guard let data = buf.floatChannelData else { continue }
            let agc = AGCProcessor()
            let frames = Int(buf.frameLength)
            let chCount = Int(buf.format.channelCount)
            var pos = 0
            while pos < frames {
                let nn = min(chunk, frames - pos)
                var chans: [UnsafeMutablePointer<Float>] = []
                for c in 0..<chCount { chans.append(data[c] + pos * buf.stride) }
                agc.process(chans, frames: nn, stride: buf.stride, sampleRate: target.sampleRate)
                pos += nn
            }
        }
    }

    // 2) 加算（クリップさせず float のまま。ピークは後段リミッターが抑える）
    let n = buffers.map { $0.frameLength }.max() ?? 0
    guard n > 0, let mixed = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: n) else {
        die(1, "mix: 出力バッファ確保に失敗。")
    }
    mixed.frameLength = n
    for ch in 0..<2 {
        let dst = mixed.floatChannelData![ch]
        for i in 0..<Int(n) { dst[i] = 0 }
        for buf in buffers {
            guard let src = buf.floatChannelData else { continue }
            // モノラル素材は ch0 を両チャンネルへ
            let sc = Int(buf.format.channelCount)
            let s = src[min(ch, sc - 1)]
            let len = Int(buf.frameLength)
            for i in 0..<min(Int(n), len) { dst[i] += s[i] }
        }
    }

    // 3) 最終ラウドネス正規化 — 無音ゲート付き RMS を測り、静的ゲインで
    //    目標 -16 dBFS へ寄せる（±18 dB でクランプ）。
    var normGainDb: Double = 0
    if normalizeOn {
        let targetLoudRMS: Float = 0.158  // -16 dBFS
        let win = 19200                   // 400ms @48k
        let dstL = mixed.floatChannelData![0]
        let dstR = mixed.floatChannelData![1]
        var energy: Double = 0
        var counted = 0
        var pos = 0
        while pos < Int(n) {
            let nn = min(win, Int(n) - pos)
            var sum: Float = 0
            for i in pos..<(pos + nn) { sum += dstL[i] * dstL[i] + dstR[i] * dstR[i] }
            let rms = (sum / Float(nn * 2)).squareRoot()
            if rms > 0.003 { energy += Double(rms * rms) * Double(nn); counted += nn } // ゲート -50 dBFS
            pos += nn
        }
        if counted > 0 {
            let rms = Float((energy / Double(counted)).squareRoot())
            let g = min(max(targetLoudRMS / rms, 0.125), 8.0)
            for ch in 0..<2 {
                let dst = mixed.floatChannelData![ch]
                for i in 0..<Int(n) { dst[i] *= g }
            }
            normGainDb = 20 * log10(Double(g))
        }
    }

    // 4) ルックアヘッドリミッター（シーリング -1 dBFS）— 常時有効の最終安全弁。
    applyLookaheadLimiter(mixed, ceiling: 0.891, sampleRate: target.sampleRate)

    // 5) 出力チャンネル数。内部処理は常に 2ch で行い、モノラル指定なら最後に
    //    L/R を平均して 1ch へダウンミックスする（会議は L≒R になりがちで、
    //    2ch はファイルを倍にするだけのため。加算でなく平均でマイクの二重加算を防ぐ）。
    let writeBuf: AVAudioPCMBuffer
    if outChannels == 1 {
        guard let monoFmt = AVAudioFormat(standardFormatWithSampleRate: 48000, channels: 1),
              let mono = AVAudioPCMBuffer(pcmFormat: monoFmt, frameCapacity: n) else {
            die(1, "mix: モノラル出力バッファ確保に失敗。")
        }
        mono.frameLength = n
        let dst = mono.floatChannelData![0]
        let l = mixed.floatChannelData![0]
        let r = mixed.floatChannelData![1]
        for i in 0..<Int(n) { dst[i] = (l[i] + r[i]) * 0.5 }
        writeBuf = mono
    } else {
        writeBuf = mixed
    }

    let outURL = URL(fileURLWithPath: out)
    try? FileManager.default.removeItem(at: outURL)
    // 出力サンプルレートは 48000Hz 固定（ミックスバッファが 48000Hz のため。再サンプルによる劣化/失敗を避ける）。
    // ファイルサイズは設定サンプルレートに比例したビットレートで縮める。
    let outSettings: [String: Any] = [
        AVFormatIDKey: kAudioFormatMPEG4AAC,
        AVSampleRateKey: 48000,
        AVNumberOfChannelsKey: outChannels,
        AVEncoderBitRateKey: scaledBitrate(192000, sampleRate: mixSampleRate),
    ]
    do {
        let outFile = try AVAudioFile(forWriting: outURL, settings: outSettings)
        try outFile.write(from: writeBuf)
    } catch { die(4, "mix: 書き出し失敗: \(error)") }

    let outAttrs = try? FileManager.default.attributesOfItem(atPath: out)
    let bytes = (outAttrs?[.size] as? Int64) ?? 0
    let line: [String: Any] = ["event": "mixed", "path": out, "bytes": Int(bytes),
                               "durationSec": Int(Double(n) / 48000.0),
                               "agc": agcOn, "normalized": normalizeOn,
                               "normGainDb": (normGainDb * 10).rounded() / 10]
    if let d = try? JSONSerialization.data(withJSONObject: line, options: [.sortedKeys]),
       let s = String(data: d, encoding: .utf8) {
        FileHandle.standardOutput.write(Data((s + "\n").utf8))
    }
    exit(0)
}

// ============================================================
// エントリポイント
// ============================================================

@main
struct SysRec {
    static func main() {
        let argv = Array(CommandLine.arguments.dropFirst())

        // 権限プリフライト（録音を開始せずマイク/オーディオ録音許可の有無だけ返す。doctor 用）
        // タップ移行により画面収録権限は不要。マイク（AVAudioEngine）の許可を確認する。
        // 終了コード: 0=許可あり / 2=許可なし
        if argv.first == "check-permission" {
            exit(AVCaptureDevice.authorizationStatus(for: .audio) == .authorized ? 0 : 2)
        }

        // 入力（マイク）デバイス一覧を JSON で出力（[{uid,name}]・doctor/UI 用）。
        // uid は microphoneCaptureDeviceID にそのまま渡せる AVCaptureDevice.uniqueID。
        if argv.first == "list-devices" {
            let discovery = AVCaptureDevice.DiscoverySession(
                deviceTypes: [.microphone, .external],
                mediaType: .audio, position: .unspecified)
            let arr: [[String: String]] = discovery.devices.map {
                ["uid": $0.uniqueID, "name": $0.localizedName]
            }
            if let data = try? JSONSerialization.data(withJSONObject: arr, options: [.sortedKeys]),
               let s = String(data: data, encoding: .utf8) {
                print(s)
            } else {
                print("[]")
            }
            exit(0)
        }

        // mix サブコマンド
        if argv.first == "mix" { runMix(Array(argv.dropFirst())) }

        let opt = parseRecordArgs(argv)
        guard !opt.out.isEmpty else { die(1, "--out <path> は必須です。") }

        // 録音中のアイドルスリープ抑止（2026-07-02 の録音中断対策・本体側の本筋）。
        // coreaudiod のマイクアサーション任せにせず自前で保持する。プロセス終了で自動解除。
        // レシピ側の caffeinate -w と二重でも無害。蓋閉じスリープは防げない。
        powerActivity = ProcessInfo.processInfo.beginActivity(
            options: .idleSystemSleepDisabled, reason: "sysrec recording")

        // pidfile を先に書く（recipe が読み取る）
        if let pf = opt.pidFile {
            try? String(getpid()).write(toFile: pf, atomically: true, encoding: .utf8)
        }
        // status-file を作成（空で初期化）
        if let sf = opt.statusFile, !FileManager.default.fileExists(atPath: sf) {
            FileManager.default.createFile(atPath: sf, contents: nil)
        }

        let emitter = Emitter(statusPath: opt.statusFile)
        let capture = Capture(opt, emitter)

        // 停止: SIGINT / SIGTERM
        signal(SIGINT, SIG_IGN); signal(SIGTERM, SIG_IGN)
        for sig in [SIGINT, SIGTERM] {
            let src = DispatchSource.makeSignalSource(signal: sig, queue: .main)
            src.setEventHandler { capture.stop() }
            src.resume()
            signalSources.append(src)
        }
        // 停止: 標準入力に "stop"
        DispatchQueue.global().async {
            while let line = readLine(strippingNewline: true) {
                if line.trimmingCharacters(in: .whitespaces) == "stop" { capture.stop(); break }
            }
        }

        capture.start()
        dispatchMain() // 停止イベント待ち（exit はハンドラ側）
    }
}

// シグナルソースを保持（解放されると発火しない）
var signalSources: [DispatchSourceSignal] = []
// 電源アサーションを保持（解放されるとスリープ抑止が外れる）
var powerActivity: NSObjectProtocol?
