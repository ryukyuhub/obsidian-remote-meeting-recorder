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
  initialGateState,
  initialNormalizerState,
  gateOpenRmsOf,
  nextAgcState,
  nextGateState,
  nextNormalizerState,
  rmsOf,
  GATE_OPEN_TAU,
  type AgcState,
  type GateState,
  type NormalizerState,
} from "./agc";
import type { RecorderSource } from "../types";
import { getOutputRouting, type OutputRouting } from "../audio/webDevices";

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

/** 無音ウォッチの対象ソース（system=システム音声 / mic=マイク）。 */
export type SilentSource = "system" | "mic";

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
 * サンプルレート・チャンネル数に見合った AAC ビットレート（bps）を返す。
 * M4A(AAC) のファイルサイズはサンプルレートではなくビットレートで決まるため、
 * サンプルレートを下げたら合わせてビットレートも下げないとファイルは小さくならない。
 * （低サンプルレート＝帯域が狭いので低ビットレートで十分。）
 * モノラルも同様で、実際のサイズ削減はここのビットレート半減（下限 48kbps）で実現する。
 */
export function bitrateForSampleRate(sampleRate: number, channels = 2): number {
  const stereo =
    sampleRate <= 16000
      ? 48000 // 文字起こし相当・小容量
      : sampleRate <= 24000
        ? 64000 // 標準品質・約半分
        : 128000; // 48000Hz 高音質（既定）
  return channels === 1 ? Math.max(48000, stereo / 2) : stereo;
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
   * チャンネル数（1=モノラル / 2=ステレオ）。モノラルは出力段で明示ダウンミックスする。
   * 実サンプルレートと違い、チャンネル数はループバック無音化の危険なく強制できる。
   */
  channels?: number;
  /**
   * AutoGain（AGC）。macOS の `--agc on` と同じ意味で、Web Audio 側でも
   * 目標 -20 dBFS・最大 +12 dB のレベル自動調整を掛ける。手動ミキサー時は false。
   */
  agc?: boolean;
  /** 手動ミキサー（Manual モード）: ソース別ゲイン(dB)を適用する。 */
  manualMix?: boolean;
  systemGainDb?: number;
  micGainDb?: number;
  /**
   * ノイズゲート閾値（無音カット）。"off" もしくは dBFS 文字列（例 "-40"）。
   * AGC・手動ミキサーのどちらとも独立に効く。macOS の `--mic-gate` / `--sys-gate` と
   * 同じ表現・同じ規則。
   */
  micGate?: string;
  sysGate?: string;
  /** 予期しない終了（トラック切断・録音エラー・onunload 以外の停止）で呼ばれる。 */
  onTerminated?: () => void;
  /**
   * 開始直後にレベルが 0 のままだった（＝音が入っていない）ソースがあるときに呼ばれる
   * （ソースごとに最大 1 回）。`sources` は今回無音と判定したソースで、両方 0 のときは 2 つ同時に
   * 1 回だけ届く。`outputRouting` は開始時に調べた再生デバイスの既定／通信の対応
   * （システム音声を録らない・未判明なら null）。
   */
  onSilence?: (sources: SilentSource[], outputRouting: OutputRouting | null) => void;
}

/** dB → 線形ゲイン。 */
function dbToLinear(db: number): number {
  return Math.pow(10, db / 20);
}

/**
 * 開始後この時間ずっとレベルが 0 なら「音が入っていない」と判断して警告する（マイク・両方 0）。
 * 録音対象が全部 0 なのはグラフ自体が死んでいる疑いが強いので、早めに知らせる。
 */
const SILENCE_WATCH_MS = 5000;
/**
 * システム音声だけが 0 のときの猶予。会議前に録音を始めた・開始直後に誰も話さない、といった
 * 正常な状況でもループバックは厳密に 0 になる（マイクと違い環境ノイズが乗らない）ため、
 * 5 秒では誤警告が多い。マイクに音が入っていればグラフは生きているので、長めに待ってよい。
 */
const SYSTEM_SILENCE_WATCH_MS = 20000;
const SILENCE_WATCH_INTERVAL_MS = 500;
/** AGC の更新周期（ms）。macOS はキャプチャチャンク単位なので、それに近い粒度にする。 */
const AGC_TICK_MS = 100;

/**
 * 1 ソース分の処理チェーン:
 *   source → gain(手動) → agcGain(自動) → gateGain(無音カット) → normGain(仕上げ正規化) → limiter → dest
 * 手動ミキサー中は agcGain と normGain を動かさない（1.0 のまま）。自動調整がフェーダー操作を
 * 打ち消さないようにするため（Issue #10）。
 * 測定タップは 2 箇所。`analyser` は手動フェーダー直後（メーター表示・AGC 入力・ゲート判定）、
 * `postAgcAnalyser` はゲート直後（正規化の入力）。macOS の normalize が「AGC・ゲート済みの
 * 録音ファイル」を測るのと同じ位置に合わせるため、正規化だけ測定点が後ろになる。
 */
interface SourceChain {
  /** 手動ミキサーのフェーダー。 */
  gain: GainNode;
  /** AGC が動かすゲイン（AutoGain オフなら 1.0 のまま）。 */
  agcGain: GainNode;
  /** ノイズゲート（無音カット）のゲイン（ゲート無効なら 1.0 のまま）。 */
  gateGain: GainNode;
  /** 仕上げ正規化の静的ゲイン（AutoGain のオン/オフに関わらず常時動く）。 */
  normGain: GainNode;
  /** 手動フェーダー直後のタップ（メーター表示と AGC 測定の両方に使う）。 */
  analyser: AnalyserNode;
  /** ゲート直後のタップ（正規化の測定用・行き止まり）。 */
  postAgcAnalyser: AnalyserNode;
  meterData: Uint8Array<ArrayBuffer>;
  rmsData: Float32Array<ArrayBuffer>;
  postRmsData: Float32Array<ArrayBuffer>;
  agc: AgcState;
  gate: GateState;
  /** ゲートの開閾値（線形 RMS）。null はゲート無効＝gateGain 1.0 のまま。 */
  gateOpenRms: number | null;
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
  private readonly channels?: number;
  private readonly manualMix: boolean;
  private readonly agc: boolean;
  private readonly onTerminated?: () => void;
  private readonly onSilence?: WebRecorderOptions["onSilence"];
  private silenceTimer: number | null = null;
  /** 開始時に調べた再生デバイスの既定／通信の対応（システム音声を録らない・未判明なら null）。 */
  private outputRouting: OutputRouting | null = null;

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
    this.channels = o.channels;
    this.manualMix = !!o.manualMix;
    // 手動ミキサーは AGC と排他（macOS の argv 組み立てと同じ規則）。
    this.agc = !!o.agc && !o.manualMix;
    // ノイズゲートは AGC・手動ミキサーのどちらとも独立（切るのはゲート設定 "off" のみ）。
    this.micGateOpenRms = gateOpenRmsOf(o.micGate ?? "off");
    this.sysGateOpenRms = gateOpenRmsOf(o.sysGate ?? "off");
    this.initSysGainDb = o.systemGainDb ?? 0;
    this.initMicGainDb = o.micGainDb ?? 0;
    this.onTerminated = o.onTerminated;
    this.onSilence = o.onSilence;
  }

  private readonly initSysGainDb: number;
  private readonly initMicGainDb: number;
  private readonly micGateOpenRms: number | null;
  private readonly sysGateOpenRms: number | null;

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
    // チャンネル数設定の反映。モノラルは出力段の明示ダウンミックスで実現する
    // （サンプルレートと違い AudioContext を触らないので、ループバック無音化の危険がない）。
    if (this.channels === 1) {
      dest.channelCount = 1;
      dest.channelCountMode = "explicit";
    }

    // 最終段のリミッター（歪み＝クリップ防止）。macOS の StreamingLimiter に相当し、
    // AutoGain のオン/オフに関わらず**常時**掛ける（歪み防止はレベル自動調整とは別機能）。
    const limiter = (this.limiter = this.audioCtx.createDynamicsCompressor());
    limiter.threshold.value = -1; // dBFS シーリング
    limiter.knee.value = 0; // ハードニー＝リミッター動作
    limiter.ratio.value = 20;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.1;
    limiter.connect(dest);

    // ソースごとに source → gain(手動フェーダー) → agcGain(AutoGain) → gateGain(無音カット)
    // → normGain(仕上げ正規化) → limiter → dest。
    // Analyser は手動フェーダー直後（＝AGC 適用前）から分岐する。メーターは「録音される
    // 手動バランス」を表し、同じ値を AGC の入力 RMS 測定とゲート判定にも使う（macOS と同じ測り方）。
    const connectSource = (
      s: MediaStream | null,
      initialDb: number,
      gateOpenRms: number | null
    ): SourceChain | null => {
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
      // ノイズゲート（無音カット）。sysrec の NoiseGate と同じく AGC の後段でゲートゲインを
      // 乗じ、判定は AGC 前の生 RMS で行う（AGC と綱引きしないため）。無効時は 1.0 のまま素通し。
      const gateGain = this.audioCtx!.createGain();
      gateGain.gain.value = 1;
      // 仕上げ正規化。ゲートの後ろ・リミッターの手前に置く（macOS の 録音時AGC・ゲート →
      // normalize → リミッター と同じ並び）。持ち上げた結果のピークは後段のリミッターが抑える。
      const normGain = this.audioCtx!.createGain();
      normGain.gain.value = 1;
      const postAgcAnalyser = this.audioCtx!.createAnalyser();
      postAgcAnalyser.fftSize = 256;
      node.connect(gain);
      gain.connect(analyser);
      gain.connect(agcGain);
      agcGain.connect(gateGain);
      gateGain.connect(postAgcAnalyser); // 測定用の分岐（行き止まり）
      gateGain.connect(normGain);
      normGain.connect(limiter);
      return {
        gain,
        agcGain,
        gateGain,
        normGain,
        analyser,
        postAgcAnalyser,
        meterData: new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount)),
        rmsData: new Float32Array(new ArrayBuffer(analyser.fftSize * 4)),
        postRmsData: new Float32Array(new ArrayBuffer(postAgcAnalyser.fftSize * 4)),
        agc: initialAgcState(),
        gate: initialGateState(),
        gateOpenRms,
        norm: initialNormalizerState(),
      };
    };
    this.sysChain = connectSource(this.systemStream, this.initSysGainDb, this.sysGateOpenRms);
    this.micChain = connectSource(this.micStream, this.initMicGainDb, this.micGateOpenRms);

    // 逐次追記の出力先。開けないまま録音を続けると「録れたつもりでゼロバイト」の
    // サイレント消失になるため、open を確認してから先へ進む（起動検証・設計書 §5.2 の思想）。
    this.fileStream = fs.createWriteStream(this.out);
    this.fileStream.on("error", (e) => {
      this.writeError = e;
    });
    await new Promise<void>((resolve, reject) => {
      this.fileStream!.once("open", () => resolve());
      this.fileStream!.once("error", (e) =>
        reject(new Error(`出力ファイルを作成できません: ${e.message}`))
      );
    });

    // MediaRecorder。timeslice ごとに ondataavailable → ディスクへ順序保証で追記。
    // 設定サンプルレート・チャンネル数に見合ったビットレートを指定 → ファイルサイズがこれで実際に縮む。
    // （録音自体はデバイス既定レートで行い、サイズはビットレートで制御する。）
    const opts: MediaRecorderOptions = {};
    if (this.mimeType) opts.mimeType = this.mimeType;
    opts.audioBitsPerSecond = bitrateForSampleRate(
      this.sampleRate ?? this.audioCtx.sampleRate,
      this.channels ?? 2
    );
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
    // 再生デバイスの既定／通信のずれ確認。マイク取得後のほうがデバイスのラベルが埋まりやすいので
    // この位置で行う。録音の成否には関わらないので待たない（失敗しても判定不能になるだけ）。
    void this.inspectOutputRouting().catch((e) =>
      console.debug("[remote-meeting-recorder] 再生デバイスの確認に失敗しました", e)
    );

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
   *
   * 判定はソース別（macOS の無音ウォッチと同じ規則）。以前は片方に音があれば監視を終えていたため、
   * 「マイクは録れているがシステム音声だけ無音」（会議の音が既定以外の再生デバイスへ出ている等）を
   * 見逃した。録音対象のソースごとに一度でも音が入ったかを追い、警告はソースごとに最大 1 回:
   *   - 両方 0（グラフ自体が死んでいる疑い）・マイク 0 … SILENCE_WATCH_MS で判定。両方 0 なら
   *     「両方」として 1 回だけ知らせ、システム音声を後から重ねて知らせない。
   *   - システム音声だけ 0 … 会議前の正常な無音と区別しにくいので SYSTEM_SILENCE_WATCH_MS まで待つ。
   */
  private startSilenceWatch(): void {
    const pending = new Set<SilentSource>();
    if (this.source !== "mic") pending.add("system");
    if (this.source !== "system") pending.add("mic");
    const startedAt = Date.now();
    const warn = (sources: SilentSource[]) => {
      sources.forEach((s) => pending.delete(s)); // 知らせたソースは監視対象から外す（重ねて知らせない）
      this.onSilence?.(sources, this.outputRouting);
    };
    const tick = () => {
      if (this.stopped) return;
      const { system, mic } = this.getSourceLevels();
      if (system > 0) pending.delete("system");
      if (mic > 0) pending.delete("mic");
      const elapsed = Date.now() - startedAt;
      if (elapsed >= SILENCE_WATCH_MS) {
        if (pending.has("system") && pending.has("mic")) warn(["system", "mic"]);
        else if (pending.has("mic")) warn(["mic"]);
      }
      if (elapsed >= SYSTEM_SILENCE_WATCH_MS && pending.has("system")) warn(["system"]);
      if (pending.size === 0) return; // 全対象ソースに音が入った（または警告済み）。監視終了。
      this.silenceTimer = window.setTimeout(tick, SILENCE_WATCH_INTERVAL_MS);
    };
    this.silenceTimer = window.setTimeout(tick, SILENCE_WATCH_INTERVAL_MS);
  }

  /**
   * 再生デバイスの既定／通信のずれを調べ、診断ログを出す（システム音声を録るときだけ）。
   * ループバックは Windows の既定の再生デバイスしか録らない。結果は保持して無音ウォッチの
   * 警告文に使う（ずれ単独では通知しない。会議前など正常な状況での誤警告を避けるため）。
   */
  private async inspectOutputRouting(): Promise<void> {
    const track = this.systemStream?.getAudioTracks()[0];
    if (!track) return;
    const label = track.label;
    const settings = track.getSettings();
    const routing = await getOutputRouting();
    if (this.stopped) return;
    this.outputRouting = routing;
    const info = {
      trackLabel: label,
      trackSettings: settings,
      defaultOutput: routing.defaultName,
      communicationsOutput: routing.communicationsName,
      mismatch: routing.mismatch,
    };
    if (routing.mismatch) {
      console.warn(
        "[remote-meeting-recorder] 既定の再生デバイスと既定の通信デバイスが異なります（システム音声は既定の再生デバイスのみ録音）",
        info
      );
    } else {
      console.debug("[remote-meeting-recorder] システム音声の取得元", info);
    }
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

    // AGC とノイズゲートは同じ生 RMS（手動フェーダー直後・AGC 前）で判定する。
    // ゲートは AGC のオン/オフとは独立に動く（sysrec と同じ）。
    if (this.agc || chain.gateOpenRms != null) {
      chain.analyser.getFloatTimeDomainData(chain.rmsData);
      const rms = rmsOf(chain.rmsData);
      if (this.agc) {
        chain.agc = nextAgcState(rms, chain.agc, dt);
        // ゲイン変更は setTargetAtTime で滑らかに当てる（急変のジッパーノイズを避ける）。
        chain.agcGain.gain.setTargetAtTime(chain.agc.gain, now, 0.05);
      }
      // ノイズゲート（無音カット）。開くときは語頭を切らないよう時定数も速く（8ms）、
      // 閉じは状態側の 150ms 減衰に任せてノードは tick 間の補間だけを行う。
      if (chain.gateOpenRms != null) {
        const prevGateGain = chain.gate.gain;
        chain.gate = nextGateState(rms, chain.gateOpenRms, chain.gate, dt);
        chain.gateGain.gain.setTargetAtTime(
          chain.gate.gain,
          now,
          chain.gate.gain > prevGateGain ? GATE_OPEN_TAU : 0.05
        );
      }
    }

    // 仕上げ正規化は AGC 適用後を測る（macOS が AGC 済みファイルを測るのと同じ位置）。
    //
    // 手動ミキサー中は掛けない（Issue #10）。この正規化は録音開始からの累積 RMS を目標
    // （0.2）へ寄せ続けるので、ユーザーがフェーダーを上げると「上がったぶん」を打ち消す
    // 方向にゲインを下げてしまい、**録音中にレベルを変えても変化が無い**状態になる。
    // macOS は停止後に 1 つの静的ゲインを掛ける方式なので、録音中の増減はそのまま残る。
    // Windows もそれに合わせ、手動モードでは正規化を止めてユーザーの操作を優先する
    // （クリップ防止のリミッターは手動モードでも常時有効なまま）。
    if (this.manualMix) return;
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
