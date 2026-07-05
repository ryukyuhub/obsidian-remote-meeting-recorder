// DRM対策 Spike ①②③⑤⑥⑦: Core Audio プロセスタップでシステム音声を取得する最小試作。
//
// 目的（実装レポート §6）:
//   - タップ稼働中に DRM 動画（Netflix）が黒くならないことを実機で確認する（①=本命）。
//   - 画面キャプチャ（ScreenCaptureKit）を一切使わずシステム音声が録れることを確認する（②）。
//   - 必要な TCC 権限の種別・初回プロンプト挙動を把握する（③）。
//   - タップの ASBD（サンプルレート/チャンネル/フォーマット）を実測する（⑦）。
//   - 停止/破棄の順序を厳守してリーク・デバイス残留がないことを確かめる。
//
// 本番コード（sysrec.swift）には一切触れない隔離試作。録音は N 秒間 → WAV(Float32) に書き出すだけ。
// 使い方: ./tap --seconds 15 --out /tmp/tap-spike.wav   （詳細は spike/README.md）

import Foundation
import CoreAudio
import AVFoundation

// ── ログ / エラー ──────────────────────────────────────────────
func log(_ s: String) { FileHandle.standardError.write(Data((s + "\n").utf8)) }

/// OSStatus を 4 文字コード（表示可能なら）付きで読める文字列に。
func statusStr(_ st: OSStatus) -> String {
    let n = UInt32(bitPattern: st)
    let bytes = [UInt8((n >> 24) & 0xff), UInt8((n >> 16) & 0xff), UInt8((n >> 8) & 0xff), UInt8(n & 0xff)]
    let printable = bytes.allSatisfy { $0 >= 0x20 && $0 < 0x7f }
    let cc = printable ? " '\(String(bytes: bytes, encoding: .ascii) ?? "")'" : ""
    return "\(st)\(cc)"
}

/// noErr なら ✓、失敗なら ✗ をログして false を返す。
@discardableResult
func ok(_ st: OSStatus, _ label: String) -> Bool {
    if st == noErr { log("✓ \(label)"); return true }
    log("✗ \(label): OSStatus=\(statusStr(st))")
    return false
}

// ── 引数 ───────────────────────────────────────────────────────
var seconds = 15.0
var outPath = "/tmp/tap-spike.wav"
do {
    let a = Array(CommandLine.arguments.dropFirst())
    var i = 0
    while i < a.count {
        switch a[i] {
        case "--seconds": i += 1; seconds = Double(i < a.count ? a[i] : "") ?? 15.0
        case "--out": i += 1; outPath = i < a.count ? a[i] : outPath
        default: log("不明な引数: \(a[i])")
        }
        i += 1
    }
}

let SYS = AudioObjectID(kAudioObjectSystemObject)

// ── デフォルト出力デバイスの UID（アグリゲートのクロック源に使う）─────────
func defaultOutputDeviceUID() -> String? {
    var dev = AudioObjectID(kAudioObjectUnknown)
    var sz = UInt32(MemoryLayout<AudioObjectID>.size)
    var a1 = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDefaultOutputDevice,
        mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    guard AudioObjectGetPropertyData(SYS, &a1, 0, nil, &sz, &dev) == noErr, dev != 0 else { return nil }
    // kAudioDevicePropertyDeviceUID は +1 retained な CFString を返すので Unmanaged で受ける。
    var uid: Unmanaged<CFString>?
    var usz = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    var a2 = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyDeviceUID,
        mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    guard AudioObjectGetPropertyData(dev, &a2, 0, nil, &usz, &uid) == noErr,
          let v = uid?.takeRetainedValue() else { return nil }
    return v as String
}

// ── 自プロセスの AudioObjectID（⑥ 自アプリ音の除外）─────────────────
func ownProcessObject() -> AudioObjectID {
    var pid = getpid()
    var obj = AudioObjectID(kAudioObjectUnknown)
    var sz = UInt32(MemoryLayout<AudioObjectID>.size)
    var a = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyTranslatePIDToProcessObject,
        mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    let st = AudioObjectGetPropertyData(
        SYS, &a, UInt32(MemoryLayout<pid_t>.size), &pid, &sz, &obj)
    if st != noErr { log("△ 自プロセスの ProcessObject 取得に失敗（除外なしで継続）: \(statusStr(st))") }
    return obj
}

// ── 収集バッファ（IOProc はシリアル実行・停止後にメインで読む）──────────
final class Sink {
    var samples: [Float] = []
    var channels: Int = 2
    var sampleRate: Double = 48000
    var frames: Int = 0
    func reserve(_ sec: Double) { samples.reserveCapacity(Int(sec * sampleRate) * channels + 4096) }
}
let sink = Sink()

// ── WAV(Float32 / IEEE float) 書き出し ────────────────────────────
func writeWavFloat32(_ path: String, samples: [Float], channels: Int, sampleRate: Int) {
    let byteRate = sampleRate * channels * 4
    let dataBytes = samples.count * 4
    var d = Data()
    func u32(_ v: UInt32) { var x = v.littleEndian; withUnsafeBytes(of: &x) { d.append(contentsOf: $0) } }
    func u16(_ v: UInt16) { var x = v.littleEndian; withUnsafeBytes(of: &x) { d.append(contentsOf: $0) } }
    d.append(contentsOf: Array("RIFF".utf8)); u32(UInt32(36 + dataBytes)); d.append(contentsOf: Array("WAVE".utf8))
    d.append(contentsOf: Array("fmt ".utf8)); u32(16)
    u16(3)                              // 3 = IEEE float
    u16(UInt16(channels))
    u32(UInt32(sampleRate))
    u32(UInt32(byteRate))
    u16(UInt16(channels * 4))           // block align
    u16(32)                             // bits/sample
    d.append(contentsOf: Array("data".utf8)); u32(UInt32(dataBytes))
    samples.withUnsafeBytes { d.append(contentsOf: $0) }
    do { try d.write(to: URL(fileURLWithPath: path)) } catch { log("✗ WAV 書き出し失敗: \(error)") }
}

// ═══════════════════════════════════════════════════════════════
// メイン
// ═══════════════════════════════════════════════════════════════
log("── DRM対策 Spike: Core Audio プロセスタップ ──")
log("秒数=\(seconds) 出力=\(outPath)")

// 1) タップ記述子（自プロセス除外・非ミュート＝ユーザは音を聞ける）
let ownObj = ownProcessObject()
let excludes: [AudioObjectID] = ownObj != 0 ? [ownObj] : []
let tapDesc = CATapDescription(stereoGlobalTapButExcludeProcesses: excludes)
tapDesc.name = "RMR Spike Tap"
tapDesc.isPrivate = true
tapDesc.muteBehavior = .unmuted
log("記述子: 除外プロセス=\(excludes) private=true mute=unmuted uuid=\(tapDesc.uuid.uuidString)")

// 2) タップ生成（③: ここで TCC プロンプト/エラーが出るはず）
var tapID = AudioObjectID(kAudioObjectUnknown)
guard ok(AudioHardwareCreateProcessTap(tapDesc, &tapID), "AudioHardwareCreateProcessTap"), tapID != 0 else {
    log("→ タップを作成できませんでした。権限（③）を確認してください。終了します。")
    exit(2)
}

// 3) フォーマット（⑦: ASBD 実測）
var asbd = AudioStreamBasicDescription()
var asbdSize = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
var fmtAddr = AudioObjectPropertyAddress(
    mSelector: kAudioTapPropertyFormat,
    mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
if ok(AudioObjectGetPropertyData(tapID, &fmtAddr, 0, nil, &asbdSize, &asbd), "kAudioTapPropertyFormat") {
    let flags = asbd.mFormatFlags
    let isFloat = (flags & kAudioFormatFlagIsFloat) != 0
    let nonInterleaved = (flags & kAudioFormatFlagIsNonInterleaved) != 0
    log("⑦ ASBD: \(asbd.mSampleRate)Hz ch=\(asbd.mChannelsPerFrame) bits=\(asbd.mBitsPerChannel) "
        + "float=\(isFloat) nonInterleaved=\(nonInterleaved) fmtID=\(statusStr(OSStatus(bitPattern: asbd.mFormatID)))")
    sink.channels = Int(asbd.mChannelsPerFrame)
    sink.sampleRate = asbd.mSampleRate > 0 ? asbd.mSampleRate : 48000
}
sink.reserve(seconds)

// 4) アグリゲートデバイス（タップをサブタップに、出力デバイスをクロック源に）
guard let outUID = defaultOutputDeviceUID() else {
    log("✗ デフォルト出力デバイス UID を取得できませんでした。終了します。")
    AudioHardwareDestroyProcessTap(tapID); exit(1)
}
log("出力デバイス UID=\(outUID)")
let aggUID = "RMR-Spike-Agg-\(UUID().uuidString)"
let aggDesc: [String: Any] = [
    kAudioAggregateDeviceNameKey as String: "RMR Spike Aggregate",
    kAudioAggregateDeviceUIDKey as String: aggUID,
    kAudioAggregateDeviceMainSubDeviceKey as String: outUID,
    kAudioAggregateDeviceIsPrivateKey as String: true,
    kAudioAggregateDeviceIsStackedKey as String: false,
    kAudioAggregateDeviceSubDeviceListKey as String: [[kAudioSubDeviceUIDKey as String: outUID]],
    kAudioAggregateDeviceTapListKey as String: [[
        kAudioSubTapUIDKey as String: tapDesc.uuid.uuidString,
        kAudioSubTapDriftCompensationKey as String: true,
    ]],
]
var aggID = AudioObjectID(kAudioObjectUnknown)
guard ok(AudioHardwareCreateAggregateDevice(aggDesc as CFDictionary, &aggID), "AudioHardwareCreateAggregateDevice"),
      aggID != 0 else {
    AudioHardwareDestroyProcessTap(tapID); exit(1)
}

// 5) IOProc 登録（タップ音声を受けて interleave して蓄積）
var ioProcID: AudioDeviceIOProcID?
let ioBlock: AudioDeviceIOBlock = { (_, inInputData, _, _, _) in
    let abl = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: inInputData))
    guard abl.count > 0 else { return }
    let nBuf = abl.count
    let ch0 = Int(abl[0].mNumberChannels)
    guard ch0 > 0, abl[0].mData != nil else { return }
    let framesPerBuf = Int(abl[0].mDataByteSize) / (MemoryLayout<Float>.size * ch0)
    // interleaved(1バッファ×Nch) / non-interleaved(Nバッファ×1ch) の両方を素直に平坦化。
    for f in 0..<framesPerBuf {
        for b in 0..<nBuf {
            let buf = abl[b]
            let ch = Int(buf.mNumberChannels)
            guard let p = buf.mData?.assumingMemoryBound(to: Float.self) else { continue }
            for c in 0..<ch { sink.samples.append(p[f * ch + c]) }
        }
    }
    sink.frames += framesPerBuf
}
guard ok(AudioDeviceCreateIOProcIDWithBlock(&ioProcID, aggID, nil, ioBlock), "AudioDeviceCreateIOProcIDWithBlock"),
      let ioProc = ioProcID else {
    AudioHardwareDestroyAggregateDevice(aggID); AudioHardwareDestroyProcessTap(tapID); exit(1)
}

// 6) 開始
guard ok(AudioDeviceStart(aggID, ioProc), "AudioDeviceStart") else {
    AudioDeviceDestroyIOProcID(aggID, ioProc)
    AudioHardwareDestroyAggregateDevice(aggID); AudioHardwareDestroyProcessTap(tapID); exit(1)
}
log("▶ 録音中… \(Int(seconds)) 秒。いま Netflix を再生して『黒くならないか（①）』を目視確認してください。")

// N 秒回す（IOProc は別スレッド。メインは寝るだけ）
Thread.sleep(forTimeInterval: seconds)

// 7) 停止 → 破棄（順序厳守: Stop → DestroyIOProcID → DestroyAggregate → DestroyProcessTap）
log("■ 停止します…")
ok(AudioDeviceStop(aggID, ioProc), "AudioDeviceStop")
ok(AudioDeviceDestroyIOProcID(aggID, ioProc), "AudioDeviceDestroyIOProcID")
ok(AudioHardwareDestroyAggregateDevice(aggID), "AudioHardwareDestroyAggregateDevice")
ok(AudioHardwareDestroyProcessTap(tapID), "AudioHardwareDestroyProcessTap")

// 集計 & 書き出し
let capturedSec = sink.channels > 0 ? Double(sink.samples.count) / Double(sink.channels) / sink.sampleRate : 0
var peak: Float = 0
for s in sink.samples { let a = abs(s); if a > peak { peak = a } }
log(String(format: "② 収集: %d frames / %.2f 秒 / ピーク %.4f（無音なら ~0）", sink.frames, capturedSec, peak))
writeWavFloat32(outPath, samples: sink.samples, channels: max(1, sink.channels), sampleRate: Int(sink.sampleRate))
log("→ WAV: \(outPath)（再生して②の音を耳で確認）")
log("── 完了 ──")
