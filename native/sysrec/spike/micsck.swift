// DRM対策 Spike ④（最重要・スコープ確定）: マイク単独の ScreenCaptureKit ストリーム試作。
//
// 目的（実装レポート §5・§6-④）:
//   システム音声を取らず「マイクだけ」を SCStream(captureMicrophone) で取得しても、
//   OS が「画面録画中」状態になり Netflix 等の DRM 映像が黒くなるか？ を実機で確定させる。
//
//   ├─ 黒くなる  → マイクも SCK から外す必要がある（AVAudioEngine へ）。SCK 完全撤去＝大きめの書き換え。
//   └─ 黒くならない → マイクは SCK 継続可。システム音声のみタップ化＝小さめの書き換え。
//
// 本番の configureAndStart()（sysrec.swift:408-432）の mic 経路をそのまま最小再現する。
// 使い方: ./micsck --seconds 15   （録音中に Netflix を再生し、黒くなるかを目視）

import Foundation
import ScreenCaptureKit
import AVFoundation
import CoreMedia

func log(_ s: String) { FileHandle.standardError.write(Data((s + "\n").utf8)) }

var seconds = 15.0
do {
    let a = Array(CommandLine.arguments.dropFirst())
    var i = 0
    while i < a.count {
        if a[i] == "--seconds", i + 1 < a.count { i += 1; seconds = Double(a[i]) ?? 15.0 }
        i += 1
    }
}

final class MicProbe: NSObject, SCStreamDelegate, SCStreamOutput {
    var stream: SCStream?
    var samples = 0
    private let q = DispatchQueue(label: "rmr.spike.micsck")

    func start() {
        SCShareableContent.getWithCompletionHandler { [weak self] content, err in
            guard let self else { return }
            if let err = err { log("✗ SCShareableContent 取得失敗: \(err.localizedDescription)"); exit(2) }
            guard let display = content?.displays.first else { log("✗ 対象ディスプレイなし"); exit(3) }

            // 本番と同じ: display 紐づけフィルタ＝画面キャプチャ扱い。ここが DRM トリガの疑い箇所。
            let filter = SCContentFilter(display: display, excludingWindows: [])
            let cfg = SCStreamConfiguration()
            cfg.capturesAudio = false          // システム音声は録らない（mic 単独を切り分ける）
            cfg.captureMicrophone = true
            cfg.sampleRate = 48000
            cfg.channelCount = 1
            cfg.width = 100; cfg.height = 100
            cfg.minimumFrameInterval = CMTime(value: 1, timescale: 1)
            cfg.excludesCurrentProcessAudio = true

            let stream = SCStream(filter: filter, configuration: cfg, delegate: self)
            do {
                try stream.addStreamOutput(self, type: .microphone, sampleHandlerQueue: self.q)
            } catch {
                log("✗ addStreamOutput(.microphone) 失敗: \(error)"); exit(1)
            }
            self.stream = stream
            stream.startCapture { err in
                if let err = err as NSError? {
                    if err.domain == SCStreamErrorDomain {
                        log("✗ 権限がありません（画面収録/マイク）: \(err.localizedDescription)"); exit(2)
                    }
                    log("✗ startCapture 失敗: \(err.localizedDescription)"); exit(1)
                }
                log("▶ mic 単独 SCStream 稼働中… \(Int(seconds)) 秒。")
                log("   いま Netflix 等の DRM 動画を再生し、『黒くなるか（④）』を目視確認してください。")
            }
        }
    }

    func stream(_ s: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .microphone, CMSampleBufferDataIsReady(sb) else { return }
        samples += CMSampleBufferGetNumSamples(sb)
    }

    func stream(_ s: SCStream, didStopWithError error: Error) {
        log("stream stopped with error: \(error.localizedDescription)")
    }
}

log("── DRM対策 Spike ④: マイク単独 SCStream ──")
let probe = MicProbe()
probe.start()

// 別スレッドで startCapture が走る。メインは N 秒寝てから停止する。
Thread.sleep(forTimeInterval: seconds + 1.0) // +1s は非同期セットアップの猶予

let sem = DispatchSemaphore(value: 0)
if let stream = probe.stream {
    log("■ 停止します…")
    stream.stopCapture { err in
        if let err = err { log("停止時エラー: \(err.localizedDescription)") }
        sem.signal()
    }
    _ = sem.wait(timeout: .now() + 5)
} else {
    log("△ ストリーム未起動のまま終了（権限/セットアップ失敗の可能性）")
}
log("mic 受信サンプル数=\(probe.samples)（>0 なら mic 経路は生きている）")
log("── 判定してください: 上の再生中に画面は黒くなりましたか？ ──")
log("   黒くなった  → マイクも SCK 撤去が必要（スコープ大）")
log("   黒くならない → マイクは SCK 継続可・システム音のみタップ化（スコープ小）")
