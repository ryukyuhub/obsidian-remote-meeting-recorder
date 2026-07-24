// 既定出力デバイスの一覧表示と切替（audio-matrix.sh のデバイス切替テスト用）。
// 使い方:
//   switch-out            … 出力デバイス一覧（* が現在の既定）
//   switch-out current    … 現在の既定出力の UID だけを出力
//   switch-out <name|uid> … 名前（部分一致）か UID で既定出力を切替
import CoreAudio
import Foundation

func outputDevices() -> [(id: AudioObjectID, name: String, uid: String)] {
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDevices,
        mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var sz: UInt32 = 0
    AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &sz)
    var ids = [AudioObjectID](repeating: 0, count: Int(sz) / MemoryLayout<AudioObjectID>.size)
    AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &sz, &ids)
    return ids.compactMap { id in
        var name: Unmanaged<CFString>?
        var nsz = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        var na = AudioObjectPropertyAddress(mSelector: kAudioObjectPropertyName,
            mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        guard AudioObjectGetPropertyData(id, &na, 0, nil, &nsz, &name) == noErr,
              let n = name?.takeRetainedValue() as String? else { return nil }
        var uid: Unmanaged<CFString>?
        var usz = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        var ua = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyDeviceUID,
            mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        guard AudioObjectGetPropertyData(id, &ua, 0, nil, &usz, &uid) == noErr,
              let u = uid?.takeRetainedValue() as String? else { return nil }
        // 出力チャンネルを持つデバイスのみ
        var oa = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyStreamConfiguration,
            mScope: kAudioDevicePropertyScopeOutput, mElement: kAudioObjectPropertyElementMain)
        var osz: UInt32 = 0
        AudioObjectGetPropertyDataSize(id, &oa, 0, nil, &osz)
        guard osz > 0 else { return nil }
        let bufList = UnsafeMutableRawPointer.allocate(byteCount: Int(osz), alignment: MemoryLayout<AudioBufferList>.alignment)
        defer { bufList.deallocate() }
        let ablPtr = bufList.assumingMemoryBound(to: AudioBufferList.self)
        guard AudioObjectGetPropertyData(id, &oa, 0, nil, &osz, ablPtr) == noErr else { return nil }
        let chans = UnsafeMutableAudioBufferListPointer(ablPtr).reduce(0) { $0 + Int($1.mNumberChannels) }
        guard chans > 0 else { return nil }
        return (id, n, u)
    }
}

func currentDefault() -> AudioObjectID {
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDefaultOutputDevice,
        mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var dev = AudioObjectID(0)
    var sz = UInt32(MemoryLayout<AudioObjectID>.size)
    AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &sz, &dev)
    return dev
}

let argv = CommandLine.arguments
let devs = outputDevices()
if argv.count > 1 && argv[1] == "current" {
    let cur = currentDefault()
    if let d = devs.first(where: { $0.id == cur }) { print(d.uid) } else { exit(1) }
} else if argv.count > 1 {
    let want = argv[1]
    guard var target = devs.first(where: { $0.uid == want || $0.name.contains(want) })?.id else {
        FileHandle.standardError.write(Data("not found: \(want)\n".utf8)); exit(1)
    }
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDefaultOutputDevice,
        mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    let st = AudioObjectSetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil,
        UInt32(MemoryLayout<AudioObjectID>.size), &target)
    if st != noErr { FileHandle.standardError.write(Data("failed: \(st)\n".utf8)); exit(1) }
    print("switched: \(want)")
} else {
    let cur = currentDefault()
    for d in devs { print("\(d.id == cur ? "*" : " ") \(d.name)\t[\(d.uid)]") }
}
