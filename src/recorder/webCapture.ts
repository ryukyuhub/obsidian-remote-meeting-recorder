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
import {
  initialAgcState,
  initialNormalizerState,
  nextAgcState,
  nextNormalizerState,
  rmsOf,
  type AgcState,
  type NormalizerState,
} from "./agc";
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
  /**
   * AutoGain（AGC）。macOS の `--agc on` と同じ意味で、Web Audio 側でも
   * 目標 -20 dBFS・最大 +12 dB のレベル自動調整を掛ける。手動ミキサー時は false。
   */
  agc?: boolean;
  /** 手動ミキサー（Manual モード）: ソース別ゲイン(dB)を適用する。 */
  manualMix?: boolean;
  systemGainDb?: number;
  micGainDb?: number;
  /** 予期しない終了（トラック切断・録音エラー・onunload 以外の停止）で呼ばれる。 */
  onTerminated?: () => void;
  /** 開始直後にレベルが 0 のままだった（＝音が入っていない）ときに 1 度だけ呼ばれる。 */
  onSilence?: () => void;
}

/** dB → 線形ゲイン。 */
function dbToLinear(db: number): number {
  return Math.pow(10, db / 20);
}

/** 開始後この時間ずっとレベルが 0 なら「音が入っていない」と判断して警告する。 */
const SILENCE_WATCH_MS = 5000;
const SILENCE_WATCH_INTERVAL_MS = 500;
/** AGC の更新周期（ms）。macOS はキャプチャチャンク単位なので、それに近い粒度にする。 */
const AGC_TICK_MS = 100;

/**
 * 1 ソース分の処理チェーン:
 *   source → gain(手動) → agcGain(自動) → normGain(仕上げ正規化) → limiter → dest
 * 測定タップは 2 箇所。`analyser` は手動フェーダー直後（メーター表示と AGC 入力）、
 * `postAgcAnalyser` は AGC 直後（正規化の入力）。macOS の normalize が「AGC 済みの録音
 * ファイル」を測るのと同じ位置に合わせるため、正規化だけ測定点が後ろになる。
 */
interface SourceChain {
  /** 手動ミキサーのフェーダー。 */
  gain: GainNode;
  /** AGC が動かすゲイン（AutoGain オフなら 1.0 のまま）。 */
  agcGain: GainNode;
  /** 仕上げ正規化の静的ゲイン（AutoGain のオン/オフに関わらず常時動く）。 */
  normGain: GainNode;
  /** 手動フェーダー直後のタップ（メーター表示と AGC 測定の両方に使う）。 */
  analyser: AnalyserNode;
  /** AGC 直後のタップ（正規化の測定用・行き止まり）。 */
  postAgcAnalyser: AnalyserNode;
  meterData: Uint8Array<ArrayBuffer>;
  rmsData: Float32Array<ArrayBuffer>;
  postRmsData: Float32Array<ArrayBuffer>;
  agc: AgcState;
  norm: NormalizerState;
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
  private readonly manualMix: boolean;
  private readonly agc: boolean;
  private readonly onTerminated?: () => void;
  private readonly onSilence?: () => void;
  private silenceTimer: number | null = null;
  private silenceWarned = false;

  private systemStream: MediaStream | null = null;
  private micStream: MediaStream | null = null;
  private audioCtx: AudioContext | null = null;
  // ソース別の処理チェーン（手動フェーダー・AGC・メーター）。
  private sysChain: SourceChain | null = null;
  private micChain: SourceChain | null = null;
  private limiter: DynamicsCompressorNode | null = null;
  private agcTimer: number | null = null;
  // GC 対策で必ず参照を握るノード群。Web Audio のノードは JS 参照が切れると回収され得る。
  // このグラフは source → gain → MediaStreamDestination であり **ctx.destination に繋がらない**
  // ため、「出力に繋がっているノードは保持される」という保持規則が働かない。回収されると
  // グラフが黙って無音になる（＝経過時間だけ進む無音ファイル）ので、ローカル変数のままにしない。
  private sourceNodes: MediaStreamAudioSourceNode[] = [];
  private graphStreams: MediaStream[] = [];
  private dest: MediaStreamAudioDestinationNode | null = null;
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
    this.manualMix = !!o.manualMix;
    // 手動ミキサーは AGC と排他（macOS の argv 組み立てと同じ規則）。
    this.agc = !!o.agc && !o.manualMix;
    this.initSysGainDb = o.systemGainDb ?? 0;
    this.initMicGainDb = o.micGainDb ?? 0;
    this.onTerminated = o.onTerminated;
    this.onSilence = o.onSilence;
  }

  private readonly initSysGainDb: number;
  private readonly initMicGainDb: number;

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
    // Chromium の autoplay policy: ユーザー操作を伴わずに生成された AudioContext は
    // "suspended" で始まる（グローバルホットキー・ミニ制御ウィンドウ・コマンド経由の開始など、
    // 主ウィンドウに user activation が無い場合）。suspended のままだと dest へ音が流れず、
    // 経過時間だけ進んで**完全な無音ファイル**が出来上がる（メーターも振れない）。
    // 必ず resume し、それでも running にならないなら起動失敗として扱う
    // （無音を録り続けるより、その場で気づけるほうが被害が小さい）。
    try {
      await this.audioCtx.resume();
    } catch {
      /* state チェックで拾う */
    }
    if (this.audioCtx.state !== "running") {
      throw new Error(
        "オーディオ処理を開始できませんでした（AudioContext が suspended）。" +
          "Obsidian のウィンドウを一度クリックしてから録音を開始してください。"
      );
    }
    const dest = (this.dest = this.audioCtx.createMediaStreamDestination());

    // 最終段のリミッター（歪み＝クリップ防止）。macOS の StreamingLimiter に相当し、
    // AutoGain のオン/オフに関わらず**常時**掛ける（歪み防止はレベル自動調整とは別機能）。
    const limiter = (this.limiter = this.audioCtx.createDynamicsCompressor());
    limiter.threshold.value = -1; // dBFS シーリング
    limiter.knee.value = 0; // ハードニー＝リミッター動作
    limiter.ratio.value = 20;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.1;
    limiter.connect(dest);

    // ソースごとに source → gain(手動フェーダー) → agcGain(AutoGain) → limiter → dest。
    // Analyser は手動フェーダー直後（＝AGC 適用前）から分岐する。メーターは「録音される
    // 手動バランス」を表し、同じ値を AGC の入力 RMS 測定にも使う（macOS と同じ測り方）。
    const connectSource = (s: MediaStream | null, initialDb: number): SourceChain | null => {
      if (!s || s.getAudioTracks().length === 0) return null;
      // ソースノードへ渡すラッパー MediaStream も参照を握る（これも回収対象になり得る）。
      const graphStream = new MediaStream(s.getAudioTracks());
      this.graphStreams.push(graphStream);
      const node = this.audioCtx!.createMediaStreamSource(graphStream);
      this.sourceNodes.push(node); // 回収されると無音になるので必ず保持する
      const gain = this.audioCtx!.createGain();
      gain.gain.value = this.manualMix ? dbToLinear(initialDb) : 1;
      const analyser = this.audioCtx!.createAnalyser();
      analyser.fftSize = 256;
      const agcGain = this.audioCtx!.createGain();
      agcGain.gain.value = 1;
      // 仕上げ正規化。AGC の後ろ・リミッターの手前に置く（macOS の 録音時AGC → normalize →
      // リミッター と同じ並び）。持ち上げた結果のピークは後段のリミッターが抑える。
      const normGain = this.audioCtx!.createGain();
      normGain.gain.value = 1;
      const postAgcAnalyser = this.audioCtx!.createAnalyser();
      postAgcAnalyser.fftSize = 256;
      node.connect(gain);
      gain.connect(analyser);
      gain.connect(agcGain);
      agcGain.connect(postAgcAnalyser); // 測定用の分岐（行き止まり）
      agcGain.connect(normGain);
      normGain.connect(limiter);
      return {
        gain,
        agcGain,
        normGain,
        analyser,
        postAgcAnalyser,
        meterData: new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount)),
        rmsData: new Float32Array(new ArrayBuffer(analyser.fftSize * 4)),
        postRmsData: new Float32Array(new ArrayBuffer(postAgcAnalyser.fftSize * 4)),
        agc: initialAgcState(),
        norm: initialNormalizerState(),
      };
    };
    this.sysChain = connectSource(this.systemStream, this.initSysGainDb);
    this.micChain = connectSource(this.micStream, this.initMicGainDb);

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

    // 録音中に suspended へ落ちる（ウィンドウの隠蔽・出力デバイス切替など）と、そこから先が
    // 黙って無音になる。状態変化を捕まえて即座に復帰を試みる。
    const ctx = this.audioCtx;
    ctx.onstatechange = () => {
      if (!this.stopped && ctx.state === "suspended") void ctx.resume().catch(() => undefined);
    };

    this.startSilenceWatch();
    this.startAgc();

    // デバイス切断・共有停止などでトラックが切れたら予期しない終了として扱う。
    const onEnded = () => this.handleUnexpectedEnd();
    this.systemStream?.getAudioTracks().forEach((t) => t.addEventListener("ended", onEnded));
    this.micStream?.getAudioTracks().forEach((t) => t.addEventListener("ended", onEnded));
  }

  /** graceful finalize（冪等）。最終チャンクを書き切ってファイルを閉じ、確定バイト数を返す。 */
  async stop(): Promise<{ bytes: number }> {
    if (this.stopped) return { bytes: this.finalBytes };
    this.stopped = true;
    if (this.silenceTimer != null) {
      window.clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
    if (this.agcTimer != null) {
      window.clearTimeout(this.agcTimer);
      this.agcTimer = null;
    }

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
    this.sourceNodes.forEach((n) => n.disconnect());
    this.sourceNodes = [];
    this.graphStreams = [];
    this.sysChain = null;
    this.micChain = null;
    this.limiter = null;
    this.dest = null;
    try {
      await this.audioCtx?.close();
    } catch {
      /* noop */
    }
    this.audioCtx = null;

    this.finalBytes = statBytes(this.out);
    return { bytes: this.finalBytes };
  }

  /**
   * 開始直後の無音監視。グラフが死んでいる（AudioContext が回らない・ソースノードが回収された・
   * ループバックが音を出していない）と、経過時間だけ進んで**中身が完全な無音のファイル**が
   * 出来上がる。1 時間録ってから気づくのが最悪なので、開始から数秒レベルが厳密に 0 のままなら
   * その場で警告する（録音は止めない。会議開始前で本当に無音なだけ、という場合もあるため）。
   */
  private startSilenceWatch(): void {
    const deadline = Date.now() + SILENCE_WATCH_MS;
    const tick = () => {
      if (this.stopped || this.silenceWarned) return;
      const { system, mic } = this.getSourceLevels();
      if (system > 0 || mic > 0) return; // 音が入った＝グラフは生きている。監視終了。
      if (Date.now() < deadline) {
        this.silenceTimer = window.setTimeout(tick, SILENCE_WATCH_INTERVAL_MS);
        return;
      }
      this.silenceWarned = true;
      this.onSilence?.();
    };
    this.silenceTimer = window.setTimeout(tick, SILENCE_WATCH_INTERVAL_MS);
  }

  /**
   * AGC のループ。ソースごとに Analyser から入力 RMS を測り、`nextAgcState`（macOS の
   * AGCProcessor と同一ロジック）で次のゲインを決めて GainNode へ流し込む。
   * AutoGain オフ／手動ミキサーのときは動かさない（agcGain は 1.0 のまま＝素通し）。
   */
  /**
   * レベル処理の tick。AGC は AutoGain オンのときだけ、仕上げ正規化は**常時**動かす
   * （macOS の normalize が AutoGain のオン/オフに関わらず掛かるのと揃える）。
   * どちらも走らない構成は無いので、タイマーは無条件に起動する。
   */
  private startAgc(): void {
    const tick = () => {
      if (this.stopped) return;
      this.stepLevels(this.sysChain);
      this.stepLevels(this.micChain);
      this.agcTimer = window.setTimeout(tick, AGC_TICK_MS);
    };
    this.agcTimer = window.setTimeout(tick, AGC_TICK_MS);
  }

  private stepLevels(chain: SourceChain | null): void {
    if (!chain || !this.audioCtx) return;
    const dt = AGC_TICK_MS / 1000;
    const now = this.audioCtx.currentTime;

    if (this.agc) {
      chain.analyser.getFloatTimeDomainData(chain.rmsData);
      chain.agc = nextAgcState(rmsOf(chain.rmsData), chain.agc, dt);
      // ゲイン変更は setTargetAtTime で滑らかに当てる（急変のジッパーノイズを避ける）。
      chain.agcGain.gain.setTargetAtTime(chain.agc.gain, now, 0.05);
    }

    // 仕上げ正規化は AGC 適用後を測る（macOS が AGC 済みファイルを測るのと同じ位置）。
    chain.postAgcAnalyser.getFloatTimeDomainData(chain.postRmsData);
    chain.norm = nextNormalizerState(rmsOf(chain.postRmsData), chain.norm, dt);
    chain.normGain.gain.setTargetAtTime(chain.norm.gain, now, 0.05);
  }

  /** Analyser から周波数ビン平均で 0..1 のレベルを読む。 */
  private levelOf(chain: SourceChain | null): number {
    if (!chain) return 0;
    chain.analyser.getByteFrequencyData(chain.meterData);
    let sum = 0;
    for (let i = 0; i < chain.meterData.length; i++) sum += chain.meterData[i];
    return sum / chain.meterData.length / 255;
  }

  /** ソース別レベル（0..1）。system/mic の 2 メーター用。 */
  getSourceLevels(): { system: number; mic: number } {
    return { system: this.levelOf(this.sysChain), mic: this.levelOf(this.micChain) };
  }

  /** 表示用の入力レベル（0..1）。従来 API 互換（mic を返す。mic 無しなら system）。 */
  getLevel(): number {
    return this.micChain ? this.levelOf(this.micChain) : this.levelOf(this.sysChain);
  }

  /** 手動ミキサー: システム音のゲイン(dB)を録音中にライブ変更。 */
  setSystemGain(db: number): void {
    if (this.sysChain) this.sysChain.gain.gain.value = dbToLinear(db);
  }

  /** 手動ミキサー: マイクのゲイン(dB)を録音中にライブ変更。 */
  setMicGain(db: number): void {
    if (this.micChain) this.micChain.gain.gain.value = dbToLinear(db);
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
