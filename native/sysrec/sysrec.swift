// sysrec — macOS 会議録音バイナリ（ScreenCaptureKit）
//
// 会議録音MCP設計書.md §3.1 / §3.1a の「録音バイナリ共通契約」を実装する。
// システム音声（ScreenCaptureKit capturesAudio）とマイク（captureMicrophone, macOS 15+）を
// 取得し、source に応じて .m4a(AAC) で書き出す CLI。
//
// 使い方:
//   録音:  sysrec --out <path> [--source both|system|mic] [--mic-device <uid>]
//                 [--samplerate 48000] [--channels 2] [--agc on|off]
//                 [--status-file <path>] [--pidfile <path>]
//   ミックス: sysrec mix --in <a.m4a> --in <b.m4a> --out <out.m4a>
//             [--agc on|off] [--normalize on|off]
//             （both の 2 ファイルを 1 本へ。ffmpeg 非依存の AVFoundation 実装）
//
// レベル処理:
//   録音時   … ソース別 AGC（自動レベル調整・目標 -20 dBFS）+ 簡易リミッター（--agc off で無効）
//   ミックス … トラック別 AGC → 加算 → ラウドネス正規化（目標 -16 dBFS、--normalize off で無効）
//             → ルックアヘッドリミッター（シーリング -1 dBFS・常時有効）
//
// 停止: SIGINT / SIGTERM、または標準入力に "stop"。
// 終了コード: 0=正常 / 2=権限なし / 3=デバイスなし / 4=ディスク等 / 1=その他

import AVFoundation
import ScreenCaptureKit
import CoreGraphics
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
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: asbd.mSampleRate > 0 ? asbd.mSampleRate : 48000,
            AVNumberOfChannelsKey: Int(asbd.mChannelsPerFrame) > 0 ? Int(asbd.mChannelsPerFrame) : 2,
            AVEncoderBitRateKey: 128000,
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
// キャプチャ本体
// ============================================================

final class Capture: NSObject, SCStreamOutput, SCStreamDelegate {
    private let opt: Options
    private let emitter: Emitter
    private let q = DispatchQueue(label: "sysrec.capture")
    private var stream: SCStream?
    private var sysBox: WriterBox?
    private var micBox: WriterBox?
    private var stopping = false

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
        super.init()
    }

    func start() {
        SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: false) { [weak self] content, error in
            guard let self else { return }
            if error != nil || content == nil {
                // 権限なし（画面収録未許可）はここで弾かれる
                die(2, "画面収録の権限がありません。システム設定 > プライバシーとセキュリティ > 画面収録 を許可してください。")
            }
            guard let display = content!.displays.first else {
                die(3, "対象ディスプレイが見つかりません。")
            }
            self.configureAndStart(display: display)
        }
    }

    private func configureAndStart(display: SCDisplay) {
        let filter = SCContentFilter(display: display, excludingWindows: [])
        let cfg = SCStreamConfiguration()
        cfg.capturesAudio = (opt.source != "mic")
        cfg.captureMicrophone = (opt.source != "system")
        if let uid = opt.micDevice { cfg.microphoneCaptureDeviceID = uid }
        cfg.sampleRate = opt.sampleRate
        cfg.channelCount = opt.channels
        // 映像は不要だが SCK は display 指定が必須。最小サイズ・低fps にして破棄する。
        cfg.width = 100; cfg.height = 100
        cfg.minimumFrameInterval = CMTime(value: 1, timescale: 1)
        cfg.excludesCurrentProcessAudio = true

        let stream = SCStream(filter: filter, configuration: cfg, delegate: self)
        do {
            if cfg.capturesAudio {
                try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: q)
            }
            if cfg.captureMicrophone {
                try stream.addStreamOutput(self, type: .microphone, sampleHandlerQueue: q)
            }
        } catch {
            die(1, "ストリーム出力の追加に失敗: \(error)")
        }
        self.stream = stream
        stream.startCapture { [weak self] err in
            guard let self else { return }
            if let err = err as NSError? {
                // TCC 拒否は SCStreamErrorDomain のことが多い
                if err.domain == SCStreamErrorDomain { die(2, "録音の権限がありません: \(err.localizedDescription)") }
                die(1, "startCapture 失敗: \(err.localizedDescription)")
            }
            self.emitter.emit([
                "event": "started",
                "source": self.opt.source,
                "ts": ISO.string(from: Date()),
                "pid": Int(getpid()),
            ])
        }
    }

    // SCStreamOutput
    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
                of type: SCStreamOutputType) {
        guard !stopping, CMSampleBufferDataIsReady(sampleBuffer) else { return }
        switch type {
        case .audio: sysBox?.append(sampleBuffer)
        case .microphone: micBox?.append(sampleBuffer)
        default: break // .screen（映像）は破棄
        }
    }

    // SCStreamDelegate
    func stream(_ stream: SCStream, didStopWithError error: Error) {
        logErr("stream stopped with error: \(error)")
        finishAndExit(code: 1)
    }

    func stop() {
        q.async { [weak self] in
            guard let self, !self.stopping else { return }
            self.stopping = true
            if let s = self.stream {
                s.stopCapture { _ in self.finishAndExit(code: 0) }
            } else {
                // まだキャプチャ開始前に停止が来た場合（何も録れていない）
                self.finishAndExit(code: 0)
            }
        }
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
    var i = 0
    while i < argv.count {
        switch argv[i] {
        case "--in": i += 1; if i < argv.count { inputs.append(argv[i]) }
        case "--out": i += 1; if i < argv.count { out = argv[i] }
        case "--agc": i += 1; if i < argv.count { agcOn = (argv[i] != "off") }
        case "--normalize": i += 1; if i < argv.count { normalizeOn = (argv[i] != "off") }
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

    let outURL = URL(fileURLWithPath: out)
    try? FileManager.default.removeItem(at: outURL)
    let outSettings: [String: Any] = [
        AVFormatIDKey: kAudioFormatMPEG4AAC,
        AVSampleRateKey: 48000,
        AVNumberOfChannelsKey: 2,
        AVEncoderBitRateKey: 192000,
    ]
    do {
        let outFile = try AVAudioFile(forWriting: outURL, settings: outSettings)
        try outFile.write(from: mixed)
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

        // 権限プリフライト（録音を開始せず画面収録許可の有無だけ返す。doctor 用）
        // 終了コード: 0=許可あり / 2=許可なし
        if argv.first == "check-permission" {
            exit(CGPreflightScreenCaptureAccess() ? 0 : 2)
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
