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

/// CLI 契約（引数・サブコマンド・出力ファイルの取り決め）のバージョン。
/// プラグインが `--version` で照合し、古いバイナリを掴んでいたら録音を始めずに知らせる。
/// **CLI 契約を壊す変更を入れたらここを上げる**（新引数の追加だけなら据え置きでよい）。
/// abi 2 = タップ方式のシステム音取り込み＋control/level ファイル＋normalize サブコマンド。
let sysrecAbi = 2
// sysrecVersion は build.sh が manifest.json から Version.generated.swift へ書き出す。
// 手書き定数だと更新を忘れる（0.9.0・0.10.0 と 2 回続けて 0.8.0 のまま出荷し、
// 「sysrec を取得」で入れ替えても版数が変わらず更新できたか判別できなかった）。


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
    // 手動ミキサー（リアルタイム・ミキサー）。manual=true のとき AGC は使わず、
    // ソース別の手動ゲイン（control ファイルで録音中に更新）を適用する。
    var manual: Bool = false
    var systemGainDb: Double = 0          // 起動時の初期ゲイン（control ファイルで上書きされる）
    var micGainDb: Double = 0
    var controlFile: String? = nil        // プラグインが書く {systemGainDb,micGainDb} を polling
    var levelFile: String? = nil          // sysrec が {system,mic} の RMS を定期出力
    // マイクのノイズゲート。micGate=false でオフ。閾値は dBFS。
    // AGC・手動ミキサーのどちらとも独立に効く（切るのはこのオプションのみ）。
    var micGate: Bool = true
    var micGateDb: Double = -40
    // システム音のノイズゲート。既定オフ（相手の声を切らないため）。
    var sysGate: Bool = false
    var sysGateDb: Double = -40
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
        case "--manual": o.manual = (next() == "on")
        case "--system-gain": o.systemGainDb = Double(next()) ?? 0
        case "--mic-gain": o.micGainDb = Double(next()) ?? 0
        case "--control-file": o.controlFile = next()
        case "--level-file": o.levelFile = next()
        case "--mic-gate":
            let v = next()
            if v == "off" { o.micGate = false }
            else if let db = Double(v) { o.micGate = true; o.micGateDb = db }
        case "--sys-gate":
            let v = next()
            if v == "off" { o.sysGate = false }
            else if let db = Double(v) { o.sysGate = true; o.sysGateDb = db }
        case "--tmp": _ = next() // 予約（現状未使用）
        default: break
        }
        i += 1
    }
    return o
}

// ============================================================
// 書き出し（1 ソース = 1 AVAssetWriter）
// ============================================================

/// 1 つの音声ソース（system もしくは microphone）を AAC .m4a へ書き出す箱。
/// 最初のサンプルが届いた時点で実フォーマット(ASBD)からライタを遅延生成する。
/// agc=true なら Float32 PCM チャンクに AGC を適用してから書き出す
/// （対象外フォーマットは素通し）。gate=true（マイク）はさらにノイズゲートを掛ける。
/// リミッターは AGC の有無に関わらず常時掛ける: 歪み（クリップ）防止はレベルの
/// 自動調整とは別の機能で、AutoGain オフでも必要なため（Issue #2/#4）。
final class WriterBox {
    let path: String
    let label: String                 // "system" / "microphone"
    private var writer: AVAssetWriter?
    private var input: AVAssetWriterInput?
    private var startPTS: CMTime = .invalid
    private var lastPTS: CMTime = .zero
    private var failed = false
    private let agc: AGCProcessor?
    private let limiter = StreamingLimiter()
    private let noiseGate: NoiseGate?  // gate=true のときのみ（AGC のオン/オフとは独立）

    init(path: String, label: String, agc: Bool, gate: Bool = false, gateDb: Double = -40) {
        self.path = path
        self.label = label
        self.agc = agc ? AGCProcessor() : nil
        self.noiseGate = gate ? NoiseGate(thresholdDb: gateDb) : nil
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

    /// AGC+リミッターを適用した新しい CMSampleBuffer を返す。
    /// Float32 LPCM 以外・変換失敗時は nil（呼び出し側が元バッファを使う）。
    /// ABL の取得は withAudioBufferList を使う（手動の
    /// CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer 直呼びはサイズ厳格化で
    /// -12737 を返すことがある）。取り出した blockBuffer は元バッファと同一メモリとは
    /// 限らないため、加工後は必ず新しい CMSampleBuffer に包み直して返す。
    private func processed(_ sb: CMSampleBuffer) -> CMSampleBuffer? {
        guard let fmt = CMSampleBufferGetFormatDescription(sb),
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
                // ノイズゲート判定用に AGC 前の生 RMS を測る（マイクのみ）。
                let rawRMS = self.noiseGate != nil ? NoiseGate.rms(chans, frames: frames, stride: stride) : 0
                self.agc?.process(chans, frames: frames, stride: stride, sampleRate: sr)
                self.limiter.process(chans, frames: frames, stride: stride, sampleRate: sr)
                // 無音（生入力が閾値未満）ならゲートで出力をほぼ 0 まで落とす。
                self.noiseGate?.process(chans, frames: frames, stride: stride, sampleRate: sr, inputRMS: rawRMS)

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

/// 取り込みバッファの実時刻（ホスト時間）。デバイスが時刻を持たない場合は現在時刻で代用する。
@inline(__always)
func captureHostTime(_ ts: UnsafePointer<AudioTimeStamp>) -> UInt64 {
    let t = ts.pointee
    if t.mFlags.contains(.hostTimeValid), t.mHostTime != 0 { return t.mHostTime }
    return mach_absolute_time()
}

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

/// システム音声を Core Audio プロセスタップで取得（画面キャプチャなし）。onBuffer に native PCM を渡す。
final class TapCapturer {
    private let onBuffer: (AVAudioPCMBuffer, UInt64) -> Void
    private var tapID = AudioObjectID(kAudioObjectUnknown)
    private var aggID = AudioObjectID(kAudioObjectUnknown)
    private var ioProc: AudioDeviceIOProcID?
    /// タップが報告する形式。チャンネル数・フラグは使うが、**サンプルレートは信用しない**
    /// （実デバイスのレートと食い違う。理由は buildAggregate の注記）。
    private var tapFormat: AVAudioFormat?
    /// IOProc が実際に渡してくる形式（tapFormat のレートを集約デバイスの公称レートへ差し替えたもの）。
    private var srcFormat: AVAudioFormat?
    private var tapUUID = ""
    private var currentOutUID = ""
    private var stopped = false
    /// 再構築はすべてこのシリアルキューで行う（IOProc の張り替えが競合しないように）。
    /// 既定出力の変更リスナーもこのキューで受ける。
    private let rebuildQueue = DispatchQueue(label: "sysrec.tap.rebuild")
    private var pendingRebuild: DispatchWorkItem?
    private var listenerBlock: AudioObjectPropertyListenerBlock?
    private var listenerAddr = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDefaultOutputDevice,
        mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    /// 同一デバイスのままレートだけが変わる場合の監視（BT の A2DP 44.1kHz ⇄ HFP 16kHz など）。
    /// 既定出力デバイスの「変更」イベントは飛ばないので、これがないと追従できない。
    /// 登録/解除は再構築のたびに起きる（＝rebuildQueue 上で解除する）ため、配送キューは
    /// rebuildQueue と**別**にする。同一キューだと解除が自キューの完了待ちになった場合に
    /// 録音中デッドロックし得る。ブロック内で rebuildQueue へ渡し直して直列性は保つ。
    private let rateQueue = DispatchQueue(label: "sysrec.tap.rate")
    private var rateListenerBlock: AudioObjectPropertyListenerBlock?
    private var rateListenerDevice = AudioObjectID(kAudioObjectUnknown)
    private var rateAddr = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyNominalSampleRate,
        mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)

    init(onBuffer: @escaping (AVAudioPCMBuffer, UInt64) -> Void) { self.onBuffer = onBuffer }

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
        tapUUID = desc.uuid.uuidString

        guard AudioHardwareCreateProcessTap(desc, &tapID) == noErr, tapID != 0 else {
            throw CaptureError.msg("システム音声タップを作成できませんでした（オーディオ録音の権限を確認してください）。")
        }
        do { try refreshTapFormat() } catch {
            AudioHardwareDestroyProcessTap(tapID)
            throw error
        }

        guard let outUID = TapCapturer.defaultOutputUID() else {
            AudioHardwareDestroyProcessTap(tapID)
            throw CaptureError.msg("デフォルト出力デバイスを取得できませんでした。")
        }
        do { try buildAggregate(outUID) } catch {
            AudioHardwareDestroyProcessTap(tapID)
            throw error
        }

        // 既定出力デバイスの変更を監視する（Issue: 録音中の BT イヤホン接続/切断・出力切替で
        // 以降のシステム音が録れなくなる）。集約デバイスは outUID に固定でぶら下がるため、
        // 既定出力が変わったら集約デバイスと IOProc を作り直して追従する。タップ自体は生かす
        // ので録音は継続し、切替の瞬間に数百 ms 欠ける程度で済む。
        let block: AudioObjectPropertyListenerBlock = { [weak self] _, _ in
            self?.scheduleRebuild()
        }
        listenerBlock = block
        AudioObjectAddPropertyListenerBlock(sys, &listenerAddr, rebuildQueue, block)
    }

    /// タップの現フォーマット（チャンネル数・サンプル形式）を読み直す。
    /// サンプルレートは buildAggregate で集約デバイスの実レートへ差し替える。
    private func refreshTapFormat() throws {
        var asbd = AudioStreamBasicDescription()
        var asz = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        var faddr = AudioObjectPropertyAddress(
            mSelector: kAudioTapPropertyFormat,
            mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        guard AudioObjectGetPropertyData(tapID, &faddr, 0, nil, &asz, &asbd) == noErr,
              let fmt = AVAudioFormat(streamDescription: &asbd) else {
            throw CaptureError.msg("タップの音声フォーマットを取得できませんでした。")
        }
        tapFormat = fmt
        srcFormat = fmt
    }

    /// デバイスの公称サンプルレート。
    private static func nominalSampleRate(_ device: AudioObjectID) -> Double? {
        guard device != 0 else { return nil }
        var sr = 0.0
        var sz = UInt32(MemoryLayout<Double>.size)
        var addr = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyNominalSampleRate,
            mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        guard AudioObjectGetPropertyData(device, &addr, 0, nil, &sz, &sr) == noErr, sr > 0 else { return nil }
        return sr
    }

    /// 集約デバイス＋IOProc を outUID にぶら下げて構築・開始する（start と再構築の共通部）。
    private func buildAggregate(_ outUID: String) throws {
        let aggDesc: [String: Any] = [
            kAudioAggregateDeviceNameKey as String: "sysrec aggregate",
            kAudioAggregateDeviceUIDKey as String: "sysrec-agg-\(getpid())",
            kAudioAggregateDeviceMainSubDeviceKey as String: outUID,
            kAudioAggregateDeviceIsPrivateKey as String: true,
            kAudioAggregateDeviceIsStackedKey as String: false,
            kAudioAggregateDeviceSubDeviceListKey as String: [[kAudioSubDeviceUIDKey as String: outUID]],
            kAudioAggregateDeviceTapListKey as String: [[
                kAudioSubTapUIDKey as String: tapUUID,
                kAudioSubTapDriftCompensationKey as String: true,
            ]],
        ]
        guard AudioHardwareCreateAggregateDevice(aggDesc as CFDictionary, &aggID) == noErr, aggID != 0 else {
            throw CaptureError.msg("集約デバイスを作成できませんでした。")
        }

        // **取り込みレートはタップではなく集約デバイスに聞く。**
        // タップの報告（kAudioTapPropertyFormat）は 48000Hz 固定で返ってくることがあり、
        // IOProc に実際に流れてくるのは集約デバイス＝出力デバイスのレート（BT A2DP なら
        // 44100Hz、HFP 通話モードなら 16000Hz）。48000Hz と誤ってラベルすると下流は
        // 1 − 44100/48000 = 8.1% ぶん実時刻に追いつけず、CaptureLane が 0.25 秒ごとに
        // 無音を挿入する。結果は「8.8% 速い＋1秒に4回プツプツ切れる」録音になる（実測・0.11.0）。
        srcFormat = TapCapturer.formatWithDeviceRate(tapFormat, device: aggID)
        guard let fmt = srcFormat else {
            AudioHardwareDestroyAggregateDevice(aggID); aggID = 0
            throw CaptureError.msg("タップの音声フォーマットを取得できませんでした。")
        }
        // フレーム数はフォーマットの bytesPerFrame で数える（ラベルと数え方を必ず一致させる）。
        let bytesPerFrame = max(1, Int(fmt.streamDescription.pointee.mBytesPerFrame))

        // リアルタイムスレッド。ここでは ABL をコピーして渡すだけに留める
        // （変換・書き出しまでやると 10.67ms のバッファ周期を超えて IO 周期が落ちる）。
        // fmt は block 生成時に確定させる（RT スレッドから可変プロパティを読まない）。
        let block: AudioDeviceIOBlock = { [weak self] _, inInputData, inInputTime, _, _ in
            guard let self else { return }
            let abl = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: inInputData))
            guard abl.count >= 1, abl[0].mData != nil else { return }
            let frames = AVAudioFrameCount(Int(abl[0].mDataByteSize) / bytesPerFrame)
            guard frames > 0, let pcm = copyToPCMBuffer(abl, format: fmt, frames: frames) else { return }
            self.onBuffer(pcm, captureHostTime(inInputTime))
        }
        guard AudioDeviceCreateIOProcIDWithBlock(&ioProc, aggID, nil, block) == noErr, let proc = ioProc else {
            AudioHardwareDestroyAggregateDevice(aggID); aggID = 0
            throw CaptureError.msg("IOProc を作成できませんでした。")
        }
        guard AudioDeviceStart(aggID, proc) == noErr else {
            AudioDeviceDestroyIOProcID(aggID, proc); ioProc = nil
            AudioHardwareDestroyAggregateDevice(aggID); aggID = 0
            throw CaptureError.msg("システム音声タップを開始できませんでした。")
        }
        currentOutUID = outUID
        startRateListener(outUID)
    }

    /// タップ報告のフォーマットに、実デバイスの公称レートを被せて返す（チャンネル数・フラグは維持）。
    private static func formatWithDeviceRate(_ base: AVAudioFormat?, device: AudioObjectID) -> AVAudioFormat? {
        guard let base else { return nil }
        guard let sr = nominalSampleRate(device), abs(sr - base.sampleRate) >= 1 else { return base }
        var asbd = base.streamDescription.pointee
        asbd.mSampleRate = sr
        guard let fmt = AVAudioFormat(streamDescription: &asbd) else { return base }
        logErr("システム音: 取り込みレートをデバイス実測へ補正（タップ報告 \(Int(base.sampleRate))Hz → 実 \(Int(sr))Hz）")
        return fmt
    }

    /// 出力デバイスのレート変化を監視する（同一デバイスのまま A2DP 44.1kHz ⇄ HFP 16kHz が起きる）。
    private func startRateListener(_ outUID: String) {
        guard let devID = audioDeviceID(forUID: outUID) else { return }
        let block: AudioObjectPropertyListenerBlock = { [weak self] _, _ in
            guard let self else { return }
            self.rebuildQueue.async { self.scheduleRebuild() }
        }
        guard AudioObjectAddPropertyListenerBlock(devID, &rateAddr, rateQueue, block) == noErr else { return }
        rateListenerBlock = block
        rateListenerDevice = devID
    }

    private func stopRateListener() {
        guard let block = rateListenerBlock, rateListenerDevice != 0 else { return }
        AudioObjectRemovePropertyListenerBlock(rateListenerDevice, &rateAddr, rateQueue, block)
        rateListenerBlock = nil
        rateListenerDevice = AudioObjectID(kAudioObjectUnknown)
    }

    /// 集約デバイス側だけ畳む（タップは生かす・再構築用）。
    private func teardownAggregate() {
        stopRateListener()
        if let proc = ioProc {
            AudioDeviceStop(aggID, proc)
            AudioDeviceDestroyIOProcID(aggID, proc)
            ioProc = nil
        }
        if aggID != 0 { AudioHardwareDestroyAggregateDevice(aggID); aggID = 0 }
    }

    /// デバイス変更イベントを 300ms デバウンスして再構築する（BT 切替時はイベントが連発するため）。
    private func scheduleRebuild() {
        pendingRebuild?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.rebuildNow() }
        pendingRebuild = work
        rebuildQueue.asyncAfter(deadline: .now() + 0.3, execute: work)
    }

    /// 実際の再構築（rebuildQueue 上で実行）。失敗時は 1 秒後に 1 回だけ自動再試行し、
    /// それでもダメなら次のデバイス変更イベントに任せる（イベントは必ずまた来る）。
    private func rebuildNow(isRetry: Bool = false) {
        if stopped { return }
        guard let newUID = TapCapturer.defaultOutputUID() else {
            logErr("システム音: 既定出力を取得できず再接続を保留（デバイス遷移中の可能性）")
            if !isRetry {
                rebuildQueue.asyncAfter(deadline: .now() + 1.0) { [weak self] in self?.rebuildNow(isRetry: true) }
            }
            return
        }
        let oldUID = currentOutUID
        let oldRate = srcFormat?.sampleRate ?? 0
        // デバイスもレートも変わっていなければ何もしない（再構築は数百 ms 音が欠けるため、
        // 空振りのプロパティ通知で切らない）。どちらか一方でも不明／相違なら作り直す。
        let devRate = audioDeviceID(forUID: newUID).flatMap { TapCapturer.nominalSampleRate($0) }
        let aggRate = TapCapturer.nominalSampleRate(aggID)
        if newUID == oldUID, let d = devRate, let a = aggRate,
           abs(d - oldRate) < 1, abs(a - oldRate) < 1 { return }
        teardownAggregate()
        do {
            try refreshTapFormat()
            try buildAggregate(newUID)
            let newRate = Int(srcFormat?.sampleRate ?? 0)
            logErr("システム音: 出力の変更に追従して再接続（\(oldUID) \(Int(oldRate))Hz → \(newUID) \(newRate)Hz）")
        } catch {
            logErr("システム音: 再接続に失敗（\(error)）。1秒後に再試行します")
            if !isRetry {
                rebuildQueue.asyncAfter(deadline: .now() + 1.0) { [weak self] in self?.rebuildNow(isRetry: true) }
            }
        }
    }

    /// 停止/破棄は順序厳守（リスナー除去 → Stop → DestroyIOProcID → DestroyAggregate → DestroyProcessTap）。
    func stop() {
        stopped = true
        if let block = listenerBlock {
            AudioObjectRemovePropertyListenerBlock(
                AudioObjectID(kAudioObjectSystemObject), &listenerAddr, rebuildQueue, block)
            listenerBlock = nil
        }
        pendingRebuild?.cancel()
        // 進行中の再構築があれば完了を待ってから畳む（IOProc の二重破棄を防ぐ）。
        rebuildQueue.sync {}
        teardownAggregate()
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

/// マイクを取得して onBuffer に native PCM を渡す。
/// - 既定入力（--mic-device なし）… その既定入力デバイスへ CoreAudio IOProc を張る。
///   取れなければ AVAudioEngine の inputNode タップへフォールバック。
/// - 特定デバイス指定 … その入力デバイスを「一時的にシステム既定入力へ切替」えてから
///   CoreAudio IOProc を張って取得し、停止時に元の既定入力へ復元する。
///
/// なぜ既定入力でも AVAudioEngine を第一候補にしないのか（実機で確定・2026-07-28）:
///   既定入力が Bluetooth イヤホンだと、AVAudioEngine 経路は `engine.start()` が成功するのに
///   **バッファが 1 つも流れてこない**（マイクを開いた瞬間に HFP へ切り替わり、inputNode が
///   握ったフォーマットと実デバイスが食い違うため）。同じデバイスでも IOProc 経路なら録れる
///   ことを実測で確認した（0 フレーム vs 287325 フレーム）。会議を丸ごと無音で録ってしまう
///   事故（2026-07-28 19:17 の mic=0 フレーム）の正体がこれ。
///   Issue #1 の「非既定デバイスへ IOProc を張ると Obsidian 文脈で固まる」条件には、
///   対象が既定入力そのものなので当たらない。
///
/// なぜ既定入力へ切替えるのか（Issue #1・実機検証で確定）:
///   - AVAudioEngine の kAudioOutputUnitProperty_CurrentDevice でデバイスを差し替える方式は、
///     切替は効くのにタップへバッファが流れず無音になる。
///   - 対象デバイスへ生 IOProc を張る方式は CLI では録れるが、Obsidian(Electron) から
///     spawn された文脈では、対象が「非既定＝非アクティブ」だと起動時にシステム音タップごと
///     固まって system/mic 両方が無音になる（「規定以外だと両方録れない」の正体）。
///   - 対象が「既定入力」のときは Obsidian でも確実に録れる。そこで録音の間だけ既定入力を
///     対象デバイスへ切替え、確実な経路で録って、停止時に必ず戻す。
final class MicCapturer {
    private let engine = AVAudioEngine()
    private let onBuffer: (AVAudioPCMBuffer, UInt64) -> Void
    private var installed = false
    // 特定デバイス用 IOProc 経路の保持
    private var procDeviceID = AudioObjectID(kAudioObjectUnknown)
    private var ioProc: AudioDeviceIOProcID?
    private var deviceFormat: AVAudioFormat?
    // 一時的に既定入力を切替えた場合の復元先（nil＝切替えていない）
    private var savedDefaultInput: AudioDeviceID?
    /// 開始からこの時間で 1 バッファも来なければ、取得経路を切り替える（無音録音への防御）。
    private static let watchdogSec = 3.0
    private let stateLock = NSLock()
    private var gotBuffer = false
    private var stopped = false
    private var switched = false // 経路の切替は 1 回だけ
    /// 取得経路の張り替え／停止を直列化する（watchdog と stop の競合を防ぐ）。
    private let opLock = NSLock()
    init(onBuffer: @escaping (AVAudioPCMBuffer, UInt64) -> Void) { self.onBuffer = onBuffer }

    /// 取得経路から届いたバッファを上位へ渡す（到達を watchdog 用に記録する）。
    private func deliver(_ pcm: AVAudioPCMBuffer, _ hostTime: UInt64) {
        stateLock.lock(); gotBuffer = true; stateLock.unlock()
        onBuffer(pcm, hostTime)
    }

    func start(micDevice: String?) throws {
        opLock.lock(); defer { opLock.unlock() } // 開始中に watchdog が経路を張り替えないように
        // 特定マイク指定があり解決できたら、対象を一時的に既定入力へ切替えてから IOProc で取得する。
        if let uid = micDevice, let devID = audioDeviceID(forUID: uid) {
            // 非既定デバイスは Obsidian 文脈で起動時に固まるため、録音の間だけ既定入力を対象へ切替える。
            let prev = currentDefaultInputDevice()
            if prev != devID {
                if setDefaultInputDevice(devID) {
                    savedDefaultInput = prev
                    logErr("マイク: 対象デバイスを録音中のみ既定入力へ切替（\(prev) → \(devID)）")
                } else {
                    logErr("マイク: 既定入力の一時切替に失敗（対象デバイスをそのまま試行）")
                }
            }
            do {
                try startDeviceProc(devID)
                armWatchdog()
                return
            } catch CaptureError.msg(let m) {
                // 対象デバイスで開始できなかった → 既定入力を戻し、録音自体は失わないよう既定入力で録る。
                restoreDefaultInput()
                logErr("マイク: 特定デバイスの取得に失敗（既定入力へフォールバック）: \(m)")
            }
        } else if micDevice != nil {
            logErr("マイク: 指定 UID を解決できませんでした（既定入力を使用）: \(micDevice ?? "")")
        }
        try startDefaultInput()
        armWatchdog()
    }

    /// 既定入力を取得する。IOProc（＝特定デバイス指定と同じ経路）を優先し、失敗時のみ
    /// AVAudioEngine へ落とす。優先順位の理由はクラスの注記を参照。
    private func startDefaultInput() throws {
        let devID = currentDefaultInputDevice()
        if devID != AudioObjectID(kAudioObjectUnknown) {
            do {
                try startDeviceProc(devID)
                return
            } catch CaptureError.msg(let m) {
                logErr("マイク: 既定入力を IOProc で取得できず AVAudioEngine へフォールバック: \(m)")
            }
        }
        try startEngineDefault()
    }

    /// 開始後 watchdogSec 経っても 1 バッファも来ていなければ、もう一方の経路へ 1 回だけ張り替える。
    /// 「engine.start() は成功しているのに無音」を録り切ってしまわないための保険。
    private func armWatchdog() {
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + Self.watchdogSec) { [weak self] in
            self?.switchPathIfSilent()
        }
    }

    private func switchPathIfSilent() {
        // ロック順は常に opLock → stateLock（start/stop と同じ）。判定は opLock を取ってから行う
        // ＝開始処理が長引いている最中に「まだ来ていない」と誤判定して張り替えないため。
        opLock.lock(); defer { opLock.unlock() }
        stateLock.lock()
        let needSwitch = !gotBuffer && !stopped && !switched
        if needSwitch { switched = true }
        stateLock.unlock()
        guard needSwitch else { return }

        let wasEngine = installed
        logErr("⚠ マイク: \(Int(Self.watchdogSec))秒間 1 バッファも取得できませんでした。"
            + "取得経路を切り替えます（\(wasEngine ? "AVAudioEngine → IOProc" : "IOProc → AVAudioEngine")）")
        teardownCapture()
        do {
            if wasEngine {
                let devID = currentDefaultInputDevice()
                guard devID != AudioObjectID(kAudioObjectUnknown) else {
                    throw CaptureError.msg("既定入力デバイスを取得できませんでした。")
                }
                try startDeviceProc(devID)
            } else {
                try startEngineDefault()
            }
        } catch {
            logErr("⚠ マイク: 取得経路の切り替えにも失敗しました（マイクは録れていません）: \(error)")
        }
    }

    /// 一時切替した既定入力を元へ戻す（多重呼び出し安全）。
    private func restoreDefaultInput() {
        guard let prev = savedDefaultInput else { return }
        savedDefaultInput = nil
        _ = setDefaultInputDevice(prev)
        logErr("マイク: 既定入力を復元（\(prev)）")
    }

    /// 既定入力を AVAudioEngine でタップ（従来経路・安定）。
    private func startEngineDefault() throws {
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.channelCount > 0, format.sampleRate > 0 else {
            throw CaptureError.msg("マイク入力フォーマットが不正です（入力デバイスを確認してください）。")
        }
        input.installTap(onBus: 0, bufferSize: 4096, format: format) { [weak self] buf, when in
            self?.deliver(buf, when.hostTime != 0 ? when.hostTime : mach_absolute_time())
        }
        installed = true
        engine.prepare()
        do { try engine.start() } catch {
            input.removeTap(onBus: 0); installed = false
            throw CaptureError.msg("マイクを開始できませんでした: \(error.localizedDescription)")
        }
    }

    /// 特定デバイスを CoreAudio IOProc で直接取得（TapCapturer と同じ方式）。
    private func startDeviceProc(_ devID: AudioDeviceID) throws {
        guard var asbd = inputVirtualFormat(forDevice: devID),
              let fmt = AVAudioFormat(streamDescription: &asbd) else {
            throw CaptureError.msg("入力デバイスのフォーマットを取得できませんでした。")
        }
        deviceFormat = fmt
        // フレーム数はデバイスの bytesPerFrame から算出（Float32/Int16 等どの LPCM でも正しく数える）。
        let bytesPerFrame = max(1, Int(asbd.mBytesPerFrame))
        let block: AudioDeviceIOBlock = { [weak self] _, inInputData, inInputTime, _, _ in
            guard let self, let fmt = self.deviceFormat else { return }
            let abl = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: inInputData))
            guard abl.count >= 1, abl[0].mData != nil else { return }
            let frames = AVAudioFrameCount(Int(abl[0].mDataByteSize) / bytesPerFrame)
            guard frames > 0, let pcm = copyToPCMBuffer(abl, format: fmt, frames: frames) else { return }
            self.deliver(pcm, captureHostTime(inInputTime))
        }
        var proc: AudioDeviceIOProcID?
        let cst = AudioDeviceCreateIOProcIDWithBlock(&proc, devID, nil, block)
        guard cst == noErr, let p = proc else {
            throw CaptureError.msg("マイク IOProc を作成できませんでした（st=\(cst)）。")
        }
        let sst = AudioDeviceStart(devID, p)
        guard sst == noErr else {
            AudioDeviceDestroyIOProcID(devID, p)
            throw CaptureError.msg("マイクの取得を開始できませんでした（st=\(sst)）。")
        }
        ioProc = p; procDeviceID = devID
    }

    /// 取得経路だけ畳む（既定入力の復元はしない＝経路の張り替えと stop の共通部）。
    private func teardownCapture() {
        // IOProc 経路（停止 → Destroy の順）。
        if let p = ioProc {
            AudioDeviceStop(procDeviceID, p)
            AudioDeviceDestroyIOProcID(procDeviceID, p)
            ioProc = nil
        }
        // AVAudioEngine 経路。
        if installed { engine.inputNode.removeTap(onBus: 0); installed = false }
        engine.stop()
    }

    func stop() {
        opLock.lock(); defer { opLock.unlock() }
        stateLock.lock(); stopped = true; stateLock.unlock()
        teardownCapture()
        // 一時切替した既定入力を必ず元へ戻す。
        restoreDefaultInput()
    }
}

/// 取り込み経路の統計（stop 後の報告用）。
struct LaneStats {
    /// 書き込んだ総フレーム数（無音で補完したぶんを含む）。
    var frames: Int64 = 0
    /// うち無音で埋めたフレーム数。
    var padded: Int64 = 0
    /// 処理が詰まって捨てたバッファ数。
    var dropped: Int64 = 0
    /// 最初と最後のバッファの実時刻差（実測入力レートの算出用）。
    var elapsed: Double = 0
    /// 録音中に取り込みフォーマットが変わった回数（デバイス切替への追従）。
    var formatChanges: Int = 0
    /// 実測した入力レート（届いたフレーム数 ÷ 実時刻）。
    var inputRate: Double = 0
    /// 最終的に入力へ付いていたラベルのレート（実測補正後はその値）。
    var labeledRate: Double = 0
}

/// 1 ソース分の取り込み経路（system / mic それぞれ 1 本）。
///
/// **リアルタイムスレッドから重い処理を追い出すのがこのクラスの主目的。**
/// 以前は IOProc の中で「フォーマット変換 → ゲイン → AGC/リミッター/ゲート →
/// AVAssetWriter への書き込み」まで同期実行していた。バッファ周期（512 フレーム
/// = 10.67ms @48kHz）を超えた瞬間に Core Audio はその IO 周期を捨てるため、
/// 負荷が高いほど取りこぼしが増える。実測では平均 0.08ms でも最大 10.5ms に達しており、
/// 会議中（Obsidian＋マイク＋同期＋文字起こし）には取得率が 33% まで落ちていた。
///
/// さらに以前は時間軸を「書けたフレーム数の累積」で決めていたため、取りこぼしが
/// 無音の穴にならず後ろが前に詰まり、そのまま再生速度の狂い（早送り）になっていた。
/// ここでは各バッファの実時刻（ホスト時間）を基準に位置を決め、遅れているぶんは
/// 無音で埋める。こうすると取りこぼしても「その区間が無音になる」だけで済み、
/// system と mic の同期も保たれる。
final class CaptureLane {
    private let box: WriterBox?
    private let gain: ManualGain
    private let sampleRate: Int
    private let channels: Int
    private let label: String
    private let onLevel: (Float) -> Void
    private let queue: DispatchQueue

    // 以下はすべて queue 上でのみ触る
    private var norm: FormatNormalizer?
    private var normSrc: AVAudioFormat?
    private var frames: Int64 = 0
    private var baseHost: UInt64 = 0
    private var lastHost: UInt64 = 0
    private var paddedFrames: Int64 = 0
    private var formatChanges = 0

    // 実測レートによるラベル補正（trackInputRate / relabeled）。
    /// 取り込み側が名乗っているフォーマット（補正前）。
    private var rawFormat: AVAudioFormat?
    /// 実測で差し替えたレート（0 なら補正なし）と、そのラベルを持つフォーマット。
    private var srcRateOverride: Double = 0
    private var relabelFormat: AVAudioFormat?
    /// 直前の差し替えが自己補正由来か（デバイス切替と区別して数えるため）。
    private var selfRelabel = false
    private var rateWinStart: UInt64 = 0
    private var rateWinFrames: Int64 = 0
    private var rateWinDropped: Int64 = 0
    private var rateCandidate: Double = 0
    private var totalInputFrames: Int64 = 0

    // submit（リアルタイムスレッド）と queue の間で共有
    private let pendingLock = NSLock()
    private var pending = 0
    private var droppedBuffers: Int64 = 0
    /// 処理が詰まったときに積む上限（約 0.7 秒ぶん）。超過分は捨てて無音で埋める
    /// ＝メモリを無限に食うより、欠落を無音として正直に残すほうが安全。
    private static let maxPending = 64
    /// 実時刻とのズレをこの長さ以上検出したら無音で埋める（通常のジッタでは埋めない）。
    private static let padThresholdSec = 0.02
    /// 入力レートを実測する窓の長さ。短くても判別は付く（44100 と 48000 で 8% 違う）が、
    /// 2 窓連続で同じ結論が出たときだけ採用するので、補正が効くまで約 3 秒。
    private static let rateWindowSec = 1.5
    /// ラベルと実測がこの割合以上ずれていたら「ラベルが違う」と見なす。
    private static let rateTolerance = 0.02
    /// 実測値を丸める先の候補（ここから 1% 以内で一致したものだけ採用する）。
    private static let standardRates: [Double] = [
        8000, 11025, 16000, 22050, 24000, 32000, 44100, 48000, 88200, 96000, 176400, 192000,
    ]

    init(box: WriterBox?, gainDb: Double, sampleRate: Int, channels: Int, label: String,
         onLevel: @escaping (Float) -> Void) {
        self.box = box
        self.gain = ManualGain(db: gainDb)
        self.sampleRate = sampleRate
        self.channels = channels
        self.label = label
        self.onLevel = onLevel
        self.queue = DispatchQueue(label: "sysrec.lane.\(label)", qos: .userInitiated)
    }

    func setGainDb(_ db: Double) { gain.setTargetDb(db) }

    /// リアルタイムスレッドから呼ばれる。積むだけで、重い処理はしない。
    func submit(_ pcm: AVAudioPCMBuffer, hostTime: UInt64) {
        pendingLock.lock()
        if pending >= Self.maxPending {
            droppedBuffers += 1
            pendingLock.unlock()
            return
        }
        pending += 1
        pendingLock.unlock()
        queue.async { [weak self] in
            guard let self else { return }
            self.process(pcm, hostTime)
            self.pendingLock.lock(); self.pending -= 1; self.pendingLock.unlock()
        }
    }

    private func process(_ input: AVAudioPCMBuffer, _ hostTime: UInt64) {
        trackInputRate(input, hostTime)
        let pcm = relabeled(input) ?? input
        if norm == nil || normSrc != pcm.format {
            if normSrc != nil && normSrc != pcm.format {
                // 自己補正でラベルを差し替えたぶんはデバイス切替ではないので数えない
                // （数えると停止時の診断が「切替に追従したぶん」と誤って説明してしまう）。
                if !selfRelabel {
                    formatChanges += 1
                    logErr("\(label): 取り込みフォーマット変化（\(Int(normSrc?.sampleRate ?? 0))Hz → \(Int(pcm.format.sampleRate))Hz）に追従")
                }
            }
            selfRelabel = false
            norm = FormatNormalizer(from: pcm.format, sampleRate: Double(sampleRate),
                                    channels: AVAudioChannelCount(max(1, channels)))
            normSrc = pcm.format
        }
        guard let out = norm?.convert(pcm), out.frameLength > 0 else { return }
        if baseHost == 0 { baseHost = hostTime }
        lastHost = hostTime

        // 実時刻に対して書き込みが遅れていれば、そのぶんを無音で埋めてから書く。
        let elapsed = AVAudioTime.seconds(forHostTime: hostTime &- baseHost)
        let expected = Int64(elapsed * Double(sampleRate))
        let gap = expected - frames
        if gap > Int64(Self.padThresholdSec * Double(sampleRate)) { padSilence(gap) }

        onLevel(applyGainAndLevel(out, gain))
        appendBuffer(out)
    }

    /// **届いたデータから入力レートを実測し、ラベルが違っていたら直す。**
    ///
    /// 取り込み側が名乗るサンプルレートは実際に届くデータと食い違うことがある。実例は
    /// BT 出力（A2DP 44100Hz）で、タップは 48000Hz と報告する。buildAggregate では集約
    /// デバイスの公称レートを見て貼り替えているが、その公称レートがまだ実レートを反映して
    /// いない瞬間があり、そのときは 48000Hz のラベルのまま 44100Hz のデータが流れ続ける。
    /// こうなると下流は 1 − 44100/48000 = 8.1% ぶん実時刻に追いつけず、0.25 秒ごとに無音が
    /// 挟まる＝「1 秒に 4 回プツプツ切れる」録音になる（実測・0.11.3 / 65 分録音で 8.1%）。
    ///
    /// プロパティを信じ足す方向では取り切れないので、**届いたフレーム数 ÷ 実時刻**で
    /// 実レートを測り、ラベルと 2% 以上ずれた結論が 2 窓続いたらラベルを実測値へ差し替える。
    /// 散発的な取りこぼしも「レートが低い」ように見えるため、
    ///   - 取りこぼしのあった窓は判定に使わない
    ///   - 実測値が標準レートの 1% 以内に乗ったときだけ採用する
    ///   - 2 窓連続で同じ結論のときだけ採用する
    /// の 3 つで誤判定を防ぐ。
    private func trackInputRate(_ pcm: AVAudioPCMBuffer, _ hostTime: UInt64) {
        totalInputFrames += Int64(pcm.frameLength)
        // 届くラベル自体が変わったら（デバイス切替）補正を捨てて測り直す。
        if rawFormat != pcm.format {
            rawFormat = pcm.format
            srcRateOverride = 0
            relabelFormat = nil
            rateCandidate = 0
            startRateWindow(hostTime)
            return
        }
        if rateWinStart == 0 { startRateWindow(hostTime); return }
        rateWinFrames += Int64(pcm.frameLength)
        let span = AVAudioTime.seconds(forHostTime: hostTime &- rateWinStart)
        guard span >= Self.rateWindowSec else { return }
        pendingLock.lock(); let dropped = droppedBuffers; pendingLock.unlock()
        let clean = dropped == rateWinDropped
        let measured = Double(rateWinFrames) / span
        startRateWindow(hostTime)

        guard clean, measured > 0 else { rateCandidate = 0; return }
        let labeled = srcRateOverride > 0 ? srcRateOverride : pcm.format.sampleRate
        guard labeled > 0, abs(measured - labeled) / labeled > Self.rateTolerance,
              let snapped = Self.snapToStandardRate(measured), snapped != labeled else {
            rateCandidate = 0
            return
        }
        guard rateCandidate == snapped else { rateCandidate = snapped; return }
        rateCandidate = 0
        applyRateOverride(snapped, labeled: labeled, measured: measured)
    }

    private func startRateWindow(_ hostTime: UInt64) {
        rateWinStart = hostTime
        rateWinFrames = 0
        pendingLock.lock(); rateWinDropped = droppedBuffers; pendingLock.unlock()
    }

    /// 実測値を標準レートへ丸める（1% 以内で一致するものが無ければ採用しない）。
    private static func snapToStandardRate(_ measured: Double) -> Double? {
        var best: Double?
        var bestDiff = Double.infinity
        for r in standardRates where abs(measured - r) / r < bestDiff {
            bestDiff = abs(measured - r) / r
            best = r
        }
        return bestDiff <= 0.01 ? best : nil
    }

    /// 以降のバッファに貼り直すラベルを用意する（チャンネル数・サンプル形式はそのまま）。
    private func applyRateOverride(_ rate: Double, labeled: Double, measured: Double) {
        guard let base = rawFormat else { return }
        var asbd = base.streamDescription.pointee
        asbd.mSampleRate = rate
        guard let fmt = AVAudioFormat(streamDescription: &asbd) else { return }
        srcRateOverride = rate
        relabelFormat = fmt
        selfRelabel = true
        logErr("\(label): 取り込みレートのラベル誤りを実測で補正"
            + "（ラベル \(Int(labeled))Hz・実測 \(Int(measured.rounded()))Hz → \(Int(rate))Hz として変換）")
    }

    /// 中身は同じまま、実測で決めたレートのラベルを付け直したバッファを返す（補正なしなら nil）。
    private func relabeled(_ pcm: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
        guard let fmt = relabelFormat, fmt != pcm.format,
              let out = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: pcm.frameLength) else { return nil }
        out.frameLength = pcm.frameLength
        let src = UnsafeMutableAudioBufferListPointer(pcm.mutableAudioBufferList)
        let dst = UnsafeMutableAudioBufferListPointer(out.mutableAudioBufferList)
        guard src.count == dst.count else { return nil }
        for i in 0..<src.count {
            guard let s = src[i].mData, let d = dst[i].mData else { return nil }
            let bytes = min(Int(src[i].mDataByteSize), Int(dst[i].mDataByteSize))
            memcpy(d, s, bytes)
            dst[i].mDataByteSize = UInt32(bytes)
        }
        return out
    }

    /// 取りこぼした区間を無音で埋める（1 秒ずつ）。
    private func padSilence(_ count: Int64) {
        guard let fmt = norm?.targetFormat else { return }
        var remaining = count
        while remaining > 0 {
            let n = AVAudioFrameCount(min(Int64(sampleRate), remaining))
            guard let buf = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: n) else { return }
            buf.frameLength = n
            let abl = UnsafeMutableAudioBufferListPointer(buf.mutableAudioBufferList)
            for b in abl { if let d = b.mData { memset(d, 0, Int(b.mDataByteSize)) } }
            appendBuffer(buf)
            paddedFrames += Int64(n)
            remaining -= Int64(n)
        }
    }

    private func appendBuffer(_ buf: AVAudioPCMBuffer) {
        let pts = CMTime(value: frames, timescale: CMTimeScale(sampleRate))
        guard let sb = makeAudioSampleBuffer(from: buf, pts: pts) else { return }
        box?.append(sb)
        frames += Int64(buf.frameLength)
    }

    /// 残りを処理しきってから統計を返す（stop 後に呼ぶ）。
    func drain() -> LaneStats {
        queue.sync {}
        pendingLock.lock(); let dropped = droppedBuffers; pendingLock.unlock()
        let elapsed = lastHost > baseHost ? AVAudioTime.seconds(forHostTime: lastHost &- baseHost) : 0
        return LaneStats(frames: frames, padded: paddedFrames, dropped: dropped,
                         elapsed: elapsed, formatChanges: formatChanges,
                         inputRate: elapsed > 0 ? Double(totalInputFrames) / elapsed : 0,
                         labeledRate: srcRateOverride > 0 ? srcRateOverride : (rawFormat?.sampleRate ?? 0))
    }
}

/// interleaved Float32 バッファへ手動ゲインをランプ乗算し、適用後 RMS を返す（メーター用）。
func applyGainAndLevel(_ buf: AVAudioPCMBuffer, _ gain: ManualGain) -> Float {
    let abl = UnsafeMutableAudioBufferListPointer(buf.mutableAudioBufferList)
    guard abl.count >= 1, let data = abl[0].mData else { return 0 }
    let base = data.assumingMemoryBound(to: Float.self)
    let ch = max(1, Int(abl[0].mNumberChannels))
    var chans: [UnsafeMutablePointer<Float>] = []
    for c in 0..<ch { chans.append(base + c) }
    return gain.process(chans, frames: Int(buf.frameLength), stride: ch)
}

final class Capture {
    private let opt: Options
    private let emitter: Emitter
    private var sysBox: WriterBox?
    private var micBox: WriterBox?
    private var tap: TapCapturer?
    private var mic: MicCapturer?
    // ソースごとの取り込み経路（変換・書き込みは lane 内の専用キューで行う）。
    private var sysLane: CaptureLane?
    private var micLane: CaptureLane?
    private var sysStats = LaneStats()
    private var micStats = LaneStats()
    private var stopping = false
    private let stopLock = NSLock()
    private let levelLock = NSLock()
    private var sysLevel: Float = 0
    private var micLevel: Float = 0

    init(_ opt: Options, _ emitter: Emitter) {
        self.opt = opt; self.emitter = emitter
        // 出力先パスの用意（both は中間 2 ファイル）
        // ソース別にノイズゲート（無音を著しく減衰）を掛ける。閾値・オンオフは設定で可変で、
        // AGC・手動ミキサーとは独立。マイクは既定オン(-40dBFS)、システム音は既定オフ
        // （相手の声を切らないため）。
        if opt.source == "both" {
            let base = (opt.out as NSString).deletingPathExtension
            sysBox = WriterBox(path: base + ".sys.m4a", label: "system", agc: opt.agc,
                               gate: opt.sysGate, gateDb: opt.sysGateDb)
            micBox = WriterBox(path: base + ".mic.m4a", label: "microphone", agc: opt.agc,
                               gate: opt.micGate, gateDb: opt.micGateDb)
        } else if opt.source == "system" {
            sysBox = WriterBox(path: opt.out, label: "system", agc: opt.agc,
                               gate: opt.sysGate, gateDb: opt.sysGateDb)
        } else { // mic
            micBox = WriterBox(path: opt.out, label: "microphone", agc: opt.agc,
                               gate: opt.micGate, gateDb: opt.micGateDb)
        }
    }

    func start() {
        // lane は capturer より先に用意する（最初のバッファを取りこぼさないため）。
        if opt.source != "mic" {
            sysLane = CaptureLane(box: sysBox, gainDb: opt.systemGainDb, sampleRate: opt.sampleRate,
                                  channels: opt.channels, label: "システム音") { [weak self] v in
                self?.storeLevel(v, isSystem: true)
            }
        }
        if opt.source != "system" {
            micLane = CaptureLane(box: micBox, gainDb: opt.micGainDb, sampleRate: opt.sampleRate,
                                  channels: opt.channels, label: "マイク") { [weak self] v in
                self?.storeLevel(v, isSystem: false)
            }
        }
        do {
            if opt.source != "mic" {
                let t = TapCapturer { [weak self] pcm, host in
                    guard let self, !self.stopping else { return }
                    self.sysLane?.submit(pcm, hostTime: host)
                }
                try t.start()
                tap = t
            }
            if opt.source != "system" {
                let m = MicCapturer { [weak self] pcm, host in
                    guard let self, !self.stopping else { return }
                    self.micLane?.submit(pcm, hostTime: host)
                }
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

    /// メーター用レベルを軽く平滑化して保持（アタック速め・リリース緩め）。
    private func storeLevel(_ v: Float, isSystem: Bool) {
        levelLock.lock()
        if isSystem { sysLevel = v > sysLevel ? v : sysLevel * 0.8 + v * 0.2 }
        else { micLevel = v > micLevel ? v : micLevel * 0.8 + v * 0.2 }
        levelLock.unlock()
    }

    /// control ファイル由来のソース別ゲイン（dB）をライブ適用する（timer から呼ぶ）。
    func applyControl(systemDb: Double, micDb: Double) {
        sysLane?.setGainDb(systemDb)
        micLane?.setGainDb(micDb)
    }

    /// 現在のメーターレベル (system, mic) を返す（timer から level ファイルへ書く）。
    func currentLevels() -> (Float, Float) {
        levelLock.lock(); defer { levelLock.unlock() }
        return (sysLevel, micLevel)
    }

    func stop() {
        stopLock.lock()
        if stopping { stopLock.unlock(); return }
        stopping = true
        stopLock.unlock()
        // まずコールバックを止めてから finalize（キャプチャ停止は同期的）。
        tap?.stop()
        mic?.stop()
        // lane に積み残した分を処理しきってから writer を閉じる（末尾を切り落とさない）。
        if let l = sysLane { sysStats = l.drain() }
        if let l = micLane { micStats = l.drain() }
        finishAndExit(code: 0)
    }

    private func finishAndExit(code: Int32) {
        // 各ソースの取得フレーム数（0 なら無音＝取得不成立。障害切り分け用に残す）。
        logErr("録音終了: source=\(opt.source) system=\(sysStats.frames)フレーム mic=\(micStats.frames)フレーム")
        // 取りこぼしは無音で埋めてある。無言だと録音を聞き直すまで気づけないので必ず残す。
        reportShortfall("システム音", sysStats, enabled: opt.source != "mic")
        reportShortfall("マイク", micStats, enabled: opt.source != "system")
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

    /// 取りこぼし（無音で埋めた区間）の報告。全体の 1% を超えたら警告として出す。
    /// 原因の切り分けが要るので、実測入力レートとフォーマット変化の有無で文言を変える:
    ///   - 録音中にフォーマットが変わった … デバイス切替への追従ぶん（再接続の数百 ms）。
    ///   - 実測レートが想定より一定割合低い … 取り込みレートの取り違え（無音が等間隔に入る）。
    ///   - それ以外 … CPU 負荷による散発的な取りこぼし。
    private func reportShortfall(_ name: String, _ s: LaneStats, enabled: Bool) {
        guard enabled else { return }
        // 1 フレームも取れていない＝その系統は丸ごと無音。無言で終わらせない。
        if s.frames == 0 {
            logErr("⚠ \(name): 1 フレームも取得できませんでした（デバイスの接続状態・権限を確認してください）。")
            return
        }
        let ratio = Double(s.padded) / Double(s.frames)
        let secs = Double(s.padded) / Double(opt.sampleRate)
        if s.padded == 0 && s.dropped == 0 { return }
        let msg = "\(name): 取りこぼし \(String(format: "%.1f", secs))秒（\(String(format: "%.1f", ratio * 100))%）を無音で補完"
            + (s.dropped > 0 ? "・処理落ちで破棄 \(s.dropped) バッファ" : "")
        guard ratio > 0.01 else { logErr(msg); return }
        // レート違いの判定は**入力側どうし**（実測レート vs ラベル）で比べる。出力の
        // opt.sampleRate と比べると、入力ラベルが正しくてもレート変換の比率ぶんズレて見え、
        // レート違いを「CPU 負荷」と誤診する（0.11.3 までの実害）。
        let rateGap = s.labeledRate > 0 && s.inputRate > 0
            ? abs(s.inputRate - s.labeledRate) / s.labeledRate : 0
        if s.formatChanges > 0 {
            logErr("⚠ \(msg)。録音中に入力レートが変わりました（デバイス切替への追従ぶん）。")
        } else if rateGap > 0.02 {
            logErr("⚠ \(msg)。実測入力 \(Int(s.inputRate.rounded()))Hz / ラベル \(Int(s.labeledRate))Hz"
                + " — デバイスのサンプルレート不一致です。")
        } else {
            logErr("⚠ \(msg)。CPU 負荷が高い可能性があります。")
        }
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

    // 3) 最終ラウドネス正規化 — 目標 -16 dBFS へ静的ゲインで寄せる（±18 dB クランプ）。
    //    ミックス全体に単一ゲインを掛けるだけなので、手動ミキサーで焼いた
    //    ソース間バランスは変わらない（手動時に off にする理由は無い・Issue #4）。
    var normGainDb: Double = 0
    if normalizeOn {
        let g = loudnessGain(mixed)
        if g != 1 {
            applyStaticGain(mixed, g)
            normGainDb = 20 * log10(Double(g))
        }
    }

    // 4) ルックアヘッドリミッター（シーリング -1 dBFS）— 常時有効の最終安全弁。
    applyLookaheadLimiter(mixed, ceiling: NormSpec.ceiling, sampleRate: target.sampleRate)

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
        try writeInChunks(outFile, writeBuf)
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
// 単一ファイルの仕上げ正規化（single ソース用・Issue #4）
// ============================================================

/// 1 ファイルをラウドネス正規化して書き戻す（`normalize --in <file> --out <file>`）。
/// single ソース（system のみ／mic のみ）は mix を通らないため、AutoGain オフでは
/// どこにもゲイン補正が掛からず生レベルのまま出ていた。その仕上げ段。
/// mix と違い**再サンプルしない**（入力のサンプルレート/チャンネル数を保つ＝
/// 容量設定とアーカイブ品質を変えない）。
func runNormalize(_ argv: [String]) -> Never {
    var input = ""
    var out = ""
    var i = 0
    while i < argv.count {
        switch argv[i] {
        case "--in": i += 1; if i < argv.count { input = argv[i] }
        case "--out": i += 1; if i < argv.count { out = argv[i] }
        default: break
        }
        i += 1
    }
    guard !input.isEmpty, !out.isEmpty else {
        die(1, "normalize: --in <file> と --out <file> を指定してください。")
    }
    guard let f = try? AVAudioFile(forReading: URL(fileURLWithPath: input)) else {
        die(1, "normalize: 読み込み失敗 \(input)")
    }
    let fmt = f.processingFormat
    guard f.length > 0,
          let buf = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: AVAudioFrameCount(f.length)) else {
        die(1, "normalize: バッファ確保に失敗 \(input)")
    }
    do { try f.read(into: buf) } catch { die(1, "normalize: read 失敗 \(input): \(error)") }
    guard buf.frameLength > 0 else { die(1, "normalize: 入力が空です \(input)") }

    let g = loudnessGain(buf)
    // 変更が微小（±1 dB 未満）なら書き出さずに終了コード 3 で知らせる。呼び出し側は
    // 元ファイルをそのまま使う＝意味の無い再エンコードで音質と時間を捨てない。
    // これにより「AutoGain オンなら normalize を掛けない」という条件分岐を廃止でき、
    // AGC のゲート（-42 dBFS）を下回って AGC が効かなかった素材も救えるようになる。
    if abs(20 * log10(Double(g))) < 1.0 {
        logErr("normalize: 変更不要（\(((20 * log10(Double(g))) * 10).rounded() / 10) dB）")
        exit(3)
    }
    applyStaticGain(buf, g)
    // リミッター（シーリング -1 dBFS）は常時。持ち上げた結果のピークを抑える最終安全弁。
    applyLookaheadLimiter(buf, ceiling: NormSpec.ceiling, sampleRate: fmt.sampleRate)

    let outURL = URL(fileURLWithPath: out)
    try? FileManager.default.removeItem(at: outURL)
    let srOut = Int(fmt.sampleRate > 0 ? fmt.sampleRate : 48000)
    let outSettings: [String: Any] = [
        AVFormatIDKey: kAudioFormatMPEG4AAC,
        AVSampleRateKey: fmt.sampleRate,
        AVNumberOfChannelsKey: Int(fmt.channelCount),
        AVEncoderBitRateKey: scaledBitrate(128000, sampleRate: srOut),
    ]
    do {
        let outFile = try AVAudioFile(forWriting: outURL, settings: outSettings)
        try writeInChunks(outFile, buf)
    } catch { die(4, "normalize: 書き出し失敗: \(error)") }

    let bytes = ((try? FileManager.default.attributesOfItem(atPath: out))?[.size] as? Int64) ?? 0
    let line: [String: Any] = ["event": "normalized", "path": out, "bytes": Int(bytes),
                               "durationSec": Int(Double(buf.frameLength) / fmt.sampleRate),
                               "normGainDb": ((20 * log10(Double(g))) * 10).rounded() / 10]
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

        // バージョン申告（プラグインの互換チェック用）。古いバイナリはこれを知らないので
        // die(1) で落ちる＝「応答が無い＝古い」と判定できる。
        if argv.first == "--version" || argv.first == "version" {
            let line: [String: Any] = ["abi": sysrecAbi, "version": sysrecVersion]
            if let d = try? JSONSerialization.data(withJSONObject: line, options: [.sortedKeys]),
               let s = String(data: d, encoding: .utf8) {
                print(s)
            }
            exit(0)
        }

        // DSP 仕様の申告（契約テスト用）。レベル処理の定数は Swift（本体）と TypeScript
        // （Windows 経路 src/recorder/agc.ts）に二重実装されており、片側だけ変わる事故が
        // 実際に起きた（Issue #4 系）。E2E がこの出力と TS 定数を突き合わせて一致を保証する。
        if argv.first == "dsp-spec" {
            let spec: [String: Any] = [
                "abi": sysrecAbi,
                "version": sysrecVersion,
                "agc": [
                    "targetRms": AGCProcessor.targetRMS,
                    "gateRms": AGCProcessor.gateRMS,
                    "minGain": AGCProcessor.minGain,
                    "maxGain": AGCProcessor.maxGain,
                ],
                "norm": [
                    "targetRms": NormSpec.targetRMS,
                    "gateRms": NormSpec.gateRMS,
                    "minGain": NormSpec.minGain,
                    "maxGain": NormSpec.maxGain,
                    "silenceRms": NormSpec.silenceRMS,
                    "limiterCeiling": NormSpec.ceiling,
                ],
                "gate": [
                    "floor": NoiseGate.floor,
                    "holdSec": NoiseGate.holdSec,
                    "openTau": NoiseGate.openTau,
                    "closeTau": NoiseGate.closeTau,
                ],
            ]
            if let d = try? JSONSerialization.data(withJSONObject: spec, options: [.sortedKeys]),
               let s = String(data: d, encoding: .utf8) {
                print(s)
            }
            exit(0)
        }

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

        // normalize サブコマンド（single ソースの仕上げ・Issue #4）
        if argv.first == "normalize" { runNormalize(Array(argv.dropFirst())) }

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

        // 手動ミキサー（リアルタイム）: control ファイルを読んでソース別ゲインをライブ更新し、
        // level ファイルへ各ソースの RMS を定期出力する（メーター用）。~80ms 周期。
        // stdin が使えない（detached）ため、制御・計測はファイルシステム経由で行う。
        if opt.controlFile != nil || opt.levelFile != nil {
            let timer = DispatchSource.makeTimerSource(queue: DispatchQueue(label: "sysrec.mixer"))
            timer.schedule(deadline: .now() + 0.08, repeating: 0.08)
            timer.setEventHandler {
                // control 読み取り（手動モードのみゲインへ反映）
                if opt.manual, let cf = opt.controlFile,
                   let data = FileManager.default.contents(atPath: cf),
                   let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                    let sg = (obj["systemGainDb"] as? NSNumber)?.doubleValue ?? opt.systemGainDb
                    let mg = (obj["micGainDb"] as? NSNumber)?.doubleValue ?? opt.micGainDb
                    capture.applyControl(systemDb: sg, micDb: mg)
                }
                // level 書き込み（atomic 上書き）
                if let lf = opt.levelFile {
                    let (s, m) = capture.currentLevels()
                    let obj: [String: Any] = ["system": Double(min(1, s)), "mic": Double(min(1, m))]
                    if let d = try? JSONSerialization.data(withJSONObject: obj) {
                        try? d.write(to: URL(fileURLWithPath: lf), options: .atomic)
                    }
                }
            }
            timer.resume()
            mixerTimer = timer
        }

        dispatchMain() // 停止イベント待ち（exit はハンドラ側）
    }
}

// シグナルソースを保持（解放されると発火しない）
var signalSources: [DispatchSourceSignal] = []
// 電源アサーションを保持（解放されるとスリープ抑止が外れる）
var powerActivity: NSObjectProtocol?
// ミキサーのポーリングタイマーを保持（解放されると停止する）
var mixerTimer: DispatchSourceTimer?
