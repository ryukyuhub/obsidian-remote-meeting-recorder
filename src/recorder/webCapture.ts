// レンダラ内録音エンジン（Windows / Web Audio 経路・Windows対応 実装計画 §Phase W1）。
//
// システム音声（Electron のループバック = getDisplayMedia + audio:'loopback'）とマイク
// （getUserMedia）を Web Audio でミックスし、MediaRecorder で `out` に逐次追記する。
// sysrec のような外部プロセスは使わない（録音はレンダラ内に生きる）。
//
// 注意（macOS との非対称・設計計画 §0/§4）:
//   - Obsidian が閉じる/クラッシュすると録音も止まる（クラッシュ復元は非対応）。
//   - 緩和として timeslice で `ondataavailable` ごとにディスクへ追記し、中断されても直近まで残す。

import * as fs from "fs";
import { statBytes } from "../util/fsx";
import { getElectronRemote } from "../platform/electron";
import type { RecorderSource } from "../types";

// --- Electron remote の最小型（platform/electron.ts 経由で取得） -----------------
interface DesktopCapturerSourceLike {
  id: string;
}
interface ElectronSessionLike {
  setDisplayMediaRequestHandler(
    handler: ((request: unknown, callback: (streams: unknown) => void) => void) | null,
    opts?: { useSystemPicker?: boolean }
  ): void;
}
interface WebContentsLike {
  session: ElectronSessionLike;
}
interface ElectronRemoteLike {
  getCurrentWebContents?: () => WebContentsLike;
  session?: { defaultSession?: ElectronSessionLike };
  desktopCapturer: { getSources(opts: { types: string[] }): Promise<DesktopCapturerSourceLike[]> };
}

/** MediaRecorder で使える最良の音声フォーマットを選ぶ（mp4/AAC 優先 → webm/opus）。 */
export function pickAudioFormat(): { mimeType: string; ext: string } {
  const candidates = [
    { mimeType: "audio/mp4;codecs=mp4a.40.2", ext: ".m4a" },
    { mimeType: "audio/mp4", ext: ".m4a" },
    { mimeType: "audio/webm;codecs=opus", ext: ".webm" },
    { mimeType: "audio/webm", ext: ".webm" },
  ];
  for (const c of candidates) {
    try {
      if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(c.mimeType)) return c;
    } catch {
      /* 次候補へ */
    }
  }
  return { mimeType: "", ext: ".webm" }; // ブラウザ既定に委ねる
}

/**
 * サンプルレートに見合った AAC ビットレート（bps）を返す。
 * M4A(AAC) のファイルサイズはサンプルレートではなくビットレートで決まるため、
 * サンプルレートを下げたら合わせてビットレートも下げないとファイルは小さくならない。
 * （低サンプルレート＝帯域が狭いので低ビットレートで十分。）
 */
export function bitrateForSampleRate(sampleRate: number): number {
  if (sampleRate <= 16000) return 48000; // 文字起こし相当・小容量
  if (sampleRate <= 24000) return 64000; // 標準品質・約半分
  return 128000; // 48000Hz 高音質（既定）
}

export interface WebRecorderOptions {
  /** 出力ファイルの絶対パス（拡張子は pickAudioFormat と整合していること）。 */
  out: string;
  source: RecorderSource;
  /** マイクの deviceId（省略時は既定入力）。 */
  micDevice?: string;
  /** MediaRecorder の mimeType（空ならブラウザ既定）。 */
  mimeType: string;
  /** 録音サンプルレート（Hz）。省略時は AudioContext 既定（通常デバイス値）。 */
  sampleRate?: number;
  /** 予期しない終了（トラック切断・録音エラー・onunload 以外の停止）で呼ばれる。 */
  onTerminated?: () => void;
}

/**
 * 1 録音セッションの取得・ミックス・エンコード・逐次ディスク書き込みを管理する。
 * start() で録音開始、stop() で graceful finalize（冪等）。getLevel() で表示用レベル。
 */
export class WebRecorder {
  private readonly out: string;
  private readonly source: RecorderSource;
  private readonly micDevice?: string;
  private readonly mimeType: string;
  private readonly sampleRate?: number;
  private readonly onTerminated?: () => void;

  private systemStream: MediaStream | null = null;
  private micStream: MediaStream | null = null;
  private audioCtx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private analyserData: Uint8Array<ArrayBuffer> | null = null;
  private recorder: MediaRecorder | null = null;
  private fileStream: fs.WriteStream | null = null;

  private writeChain: Promise<void> = Promise.resolve();
  private writeError: Error | null = null;
  private started = false;
  private stopped = false;
  private finalBytes = 0;

  constructor(o: WebRecorderOptions) {
    this.out = o.out;
    this.source = o.source;
    this.micDevice = o.micDevice;
    this.mimeType = o.mimeType;
    this.sampleRate = o.sampleRate;
    this.onTerminated = o.onTerminated;
  }

  /** 録音開始。ストリーム取得・ミックス・MediaRecorder 起動まで。失敗時は throw（呼び出し側で StartError 化）。 */
  async start(): Promise<void> {
    if (this.source !== "mic") this.systemStream = await this.acquireSystemStream();
    if (this.source !== "system") this.micStream = await this.acquireMicStream(this.micDevice);

    if (
      (this.systemStream?.getAudioTracks().length ?? 0) === 0 &&
      (this.micStream?.getAudioTracks().length ?? 0) === 0
    ) {
      throw new Error("録音対象の音声トラックを取得できませんでした");
    }

    // ミックス（system + mic → 単一の MediaStream）。表示用 Analyser も同じソースから分岐。
    // AudioContext は必ずデバイス既定レートで作る。特定レートを強制すると getDisplayMedia の
    // ループバック音声（system）がリサンプルできず無音＝データ 0 バイトになることがあるため。
    // ファイルサイズはサンプルレートではなくビットレート（下の audioBitsPerSecond）で縮める。
    this.audioCtx = new AudioContext();
    const dest = this.audioCtx.createMediaStreamDestination();
    this.analyser = this.audioCtx.createAnalyser();
    this.analyser.fftSize = 256;
    this.analyserData = new Uint8Array(new ArrayBuffer(this.analyser.frequencyBinCount));
    const connect = (s: MediaStream | null) => {
      if (!s || s.getAudioTracks().length === 0) return;
      const node = this.audioCtx!.createMediaStreamSource(new MediaStream(s.getAudioTracks()));
      node.connect(dest);
      node.connect(this.analyser!);
    };
    connect(this.systemStream);
    connect(this.micStream);

    // 逐次追記の出力先。
    this.fileStream = fs.createWriteStream(this.out);
    this.fileStream.on("error", (e) => {
      this.writeError = e;
    });

    // MediaRecorder。timeslice ごとに ondataavailable → ディスクへ順序保証で追記。
    // 設定サンプルレートに見合ったビットレートを指定 → ファイルサイズがこれで実際に縮む。
    // （録音自体はデバイス既定レートで行い、サイズはビットレートで制御する。）
    const opts: MediaRecorderOptions = {};
    if (this.mimeType) opts.mimeType = this.mimeType;
    opts.audioBitsPerSecond = bitrateForSampleRate(this.sampleRate ?? this.audioCtx.sampleRate);
    this.recorder = new MediaRecorder(dest.stream, opts);
    this.recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) this.enqueueChunk(e.data);
    };
    this.recorder.onerror = () => this.handleUnexpectedEnd();

    await new Promise<void>((resolve, reject) => {
      const rec = this.recorder!;
      const to = window.setTimeout(resolve, 1500); // onstart が来なくても前進（保険）
      rec.onstart = () => {
        window.clearTimeout(to);
        resolve();
      };
      try {
        rec.start(1000); // timeslice 1s
      } catch (e) {
        window.clearTimeout(to);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
    this.started = true;

    // デバイス切断・共有停止などでトラックが切れたら予期しない終了として扱う。
    const onEnded = () => this.handleUnexpectedEnd();
    this.systemStream?.getAudioTracks().forEach((t) => t.addEventListener("ended", onEnded));
    this.micStream?.getAudioTracks().forEach((t) => t.addEventListener("ended", onEnded));
  }

  /** graceful finalize（冪等）。最終チャンクを書き切ってファイルを閉じ、確定バイト数を返す。 */
  async stop(): Promise<{ bytes: number }> {
    if (this.stopped) return { bytes: this.finalBytes };
    this.stopped = true;

    // MediaRecorder を止めて最終 ondataavailable を吐かせる。
    await new Promise<void>((resolve) => {
      const rec = this.recorder;
      if (!rec || rec.state === "inactive") return resolve();
      rec.onstop = () => resolve();
      try {
        rec.stop();
      } catch {
        resolve();
      }
    });

    // 追記キューを流し切ってからファイルを閉じる。
    await this.writeChain.catch(() => undefined);
    if (this.fileStream) {
      await new Promise<void>((resolve) => this.fileStream!.end(() => resolve()));
      this.fileStream = null;
    }

    this.systemStream?.getTracks().forEach((t) => t.stop());
    this.micStream?.getTracks().forEach((t) => t.stop());
    try {
      await this.audioCtx?.close();
    } catch {
      /* noop */
    }
    this.audioCtx = null;

    this.finalBytes = statBytes(this.out);
    return { bytes: this.finalBytes };
  }

  /** 表示用の入力レベル（0..1）。周波数ビンの平均。 */
  getLevel(): number {
    if (!this.analyser || !this.analyserData) return 0;
    this.analyser.getByteFrequencyData(this.analyserData);
    let sum = 0;
    for (let i = 0; i < this.analyserData.length; i++) sum += this.analyserData[i];
    return sum / this.analyserData.length / 255;
  }

  get isStarted(): boolean {
    return this.started;
  }

  // --- 内部 ---------------------------------------------------------------

  /** チャンクを到着順にディスクへ書く（arrayBuffer() の await でも順序が乱れないよう直列化）。 */
  private enqueueChunk(blob: Blob): void {
    this.writeChain = this.writeChain
      .then(async () => {
        if (!this.fileStream) return;
        const buf = Buffer.from(await blob.arrayBuffer());
        await new Promise<void>((resolve, reject) =>
          this.fileStream!.write(buf, (err) => (err ? reject(err) : resolve()))
        );
      })
      .catch((e) => {
        this.writeError = e as Error;
      });
  }

  /** 予期しない終了（トラック切断・録音エラー）: finalize してから onTerminated を通知。 */
  private handleUnexpectedEnd(): void {
    if (this.stopped) return;
    void this.stop().finally(() => this.onTerminated?.());
  }

  /** システム音声（ループバック）を取得。Electron メイン session に一時ハンドラを張って getDisplayMedia。 */
  private async acquireSystemStream(): Promise<MediaStream> {
    const remote = getElectronRemote() as unknown as ElectronRemoteLike | null;
    if (!remote) {
      throw new Error("Electron remote にアクセスできません（システム音声を取得できません）");
    }
    const session =
      remote.getCurrentWebContents?.().session ?? remote.session?.defaultSession ?? null;
    if (!session) {
      throw new Error("メインプロセスの session を取得できません");
    }
    const desktopCapturer = remote.desktopCapturer;

    const handler = (_request: unknown, callback: (streams: unknown) => void) => {
      Promise.resolve(desktopCapturer.getSources({ types: ["screen"] }))
        .then((sources) => callback({ video: sources[0], audio: "loopback" }))
        .catch(() => callback({}));
    };
    try {
      session.setDisplayMediaRequestHandler(handler, { useSystemPicker: false });
    } catch {
      session.setDisplayMediaRequestHandler(handler); // 古い署名フォールバック
    }

    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      // 画面映像は録らない（音声のみ）。ビデオトラックは即停止して共有インジケータも消す。
      stream.getVideoTracks().forEach((t) => t.stop());
      if (stream.getAudioTracks().length === 0) {
        throw new Error("システム音声トラックが空でした（ループバック非対応の可能性）");
      }
      return new MediaStream(stream.getAudioTracks());
    } finally {
      try {
        session.setDisplayMediaRequestHandler(null);
      } catch {
        /* noop */
      }
    }
  }

  /** マイクを取得。指定デバイスが無ければ既定にフォールバック。 */
  private async acquireMicStream(deviceId?: string): Promise<MediaStream> {
    const base: MediaTrackConstraints = {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    };
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: deviceId ? { ...base, deviceId: { exact: deviceId } } : base,
        video: false,
      });
    } catch (e) {
      if (deviceId) {
        // 指定 deviceId が存在しない（別 OS の uid 等）→ 既定入力で再試行。
        return await navigator.mediaDevices.getUserMedia({ audio: base, video: false });
      }
      throw e;
    }
  }
}
