// DeviceKit.swift — CoreAudio デバイスユーティリティ（リファクタ調査 R5 で分割）。
// UID→デバイス ID 解決・入力フォーマット取得・既定入力の取得/切替（Issue #1 の一時切替用）。
import AVFoundation
import CoreAudio
import Foundation

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

/// 入力デバイスの仮想フォーマット(ASBD)を取得する（IOProc が渡す ABL のフォーマット）。
/// プロパティの正規の所在＝最初の入力ストリームの VirtualFormat をまず引き、
/// 取れなければデバイスへ input scope で問い合わせる（best-effort）。
func inputVirtualFormat(forDevice devID: AudioDeviceID) -> AudioStreamBasicDescription? {
    var asbd = AudioStreamBasicDescription()
    // 1) 最初の入力ストリームの VirtualFormat
    var sAddr = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyStreams,
        mScope: kAudioObjectPropertyScopeInput, mElement: kAudioObjectPropertyElementMain)
    var ssz = UInt32(0)
    if AudioObjectGetPropertyDataSize(devID, &sAddr, 0, nil, &ssz) == noErr, ssz > 0 {
        let n = Int(ssz) / MemoryLayout<AudioStreamID>.size
        var streams = [AudioStreamID](repeating: 0, count: n)
        if AudioObjectGetPropertyData(devID, &sAddr, 0, nil, &ssz, &streams) == noErr,
           let stream = streams.first {
            var fAddr = AudioObjectPropertyAddress(
                mSelector: kAudioStreamPropertyVirtualFormat,
                mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
            var fsz = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
            if AudioObjectGetPropertyData(stream, &fAddr, 0, nil, &fsz, &asbd) == noErr,
               asbd.mSampleRate > 0 { return asbd }
        }
    }
    // 2) フォールバック: デバイスへ input scope で問い合わせ
    var dAddr = AudioObjectPropertyAddress(
        mSelector: kAudioStreamPropertyVirtualFormat,
        mScope: kAudioObjectPropertyScopeInput, mElement: kAudioObjectPropertyElementMain)
    var dsz = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
    if AudioObjectGetPropertyData(devID, &dAddr, 0, nil, &dsz, &asbd) == noErr,
       asbd.mSampleRate > 0 { return asbd }
    return nil
}

/// 現在のシステム既定入力デバイス ID。
func currentDefaultInputDevice() -> AudioDeviceID {
    let sys = AudioObjectID(kAudioObjectSystemObject)
    var dev = AudioDeviceID(kAudioObjectUnknown)
    var sz = UInt32(MemoryLayout<AudioDeviceID>.size)
    var a = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDefaultInputDevice,
        mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    AudioObjectGetPropertyData(sys, &a, 0, nil, &sz, &dev)
    return dev
}

/// システム既定入力デバイスを設定（成功で true）。
func setDefaultInputDevice(_ dev: AudioDeviceID) -> Bool {
    let sys = AudioObjectID(kAudioObjectSystemObject)
    var d = dev
    var a = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDefaultInputDevice,
        mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    return AudioObjectSetPropertyData(
        sys, &a, 0, nil, UInt32(MemoryLayout<AudioDeviceID>.size), &d) == noErr
}
