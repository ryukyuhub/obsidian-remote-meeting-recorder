/**
 * マイクの「表示専用タップ」（設計書 §3.4）。
 * getUserMedia + AnalyserNode でレベル/波形を読むだけ。録音物には一切影響しない
 * （録音の真実は sysrec）。Monitor はマイク入力をそのまま出力へ流す試聴。
 */
export class WebAudioTap {
  private audioCtx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private monitorGain: GainNode | null = null;
  private data: Uint8Array<ArrayBuffer> | null = null;

  /** 指定デバイス（省略時は既定）でタップ開始。monitor=true で試聴も繋ぐ。 */
  async start(deviceId?: string, monitor = false): Promise<void> {
    this.stream = await this.acquire(deviceId);
    this.audioCtx = new AudioContext();
    this.source = this.audioCtx.createMediaStreamSource(this.stream);
    this.analyser = this.audioCtx.createAnalyser();
    this.analyser.fftSize = 256;
    this.data = new Uint8Array(new ArrayBuffer(this.analyser.frequencyBinCount));
    this.source.connect(this.analyser);
    if (monitor) this.setMonitor(true);
  }

  /**
   * 表示用タップのマイクを取得する。exact 指定が通らなければ既定入力へフォールバックする。
   * macOS では micDevice が CoreAudio UID（Chromium の deviceId とは別名前空間）なので
   * exact 指定は OverconstrainedError になる。だが録音中は sysrec が対象デバイスを既定入力へ
   * 切替えているため、既定入力（audio:true）でタップすればメーター/試聴は対象デバイスのものになる。
   */
  private async acquire(deviceId?: string): Promise<MediaStream> {
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: deviceId ? { deviceId: { exact: deviceId } } : true,
        video: false,
      });
    } catch (e) {
      if (deviceId) {
        return await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      }
      throw e;
    }
  }

  /** モニター（入力の試聴）オン/オフ。 */
  setMonitor(on: boolean): void {
    if (!this.audioCtx || !this.source) return;
    if (on && !this.monitorGain) {
      this.monitorGain = this.audioCtx.createGain();
      this.monitorGain.gain.value = 1;
      this.source.connect(this.monitorGain);
      this.monitorGain.connect(this.audioCtx.destination);
    } else if (!on && this.monitorGain) {
      this.monitorGain.disconnect();
      this.monitorGain = null;
    }
  }

  /** 現在の入力レベル（0..1）。周波数ビンの平均。 */
  getLevel(): number {
    if (!this.analyser || !this.data) return 0;
    this.analyser.getByteFrequencyData(this.data);
    let sum = 0;
    for (let i = 0; i < this.data.length; i++) sum += this.data[i];
    return sum / this.data.length / 255;
  }

  stop(): void {
    try {
      this.stream?.getTracks().forEach((t) => t.stop());
    } catch {
      // 無視
    }
    try {
      void this.audioCtx?.close();
    } catch {
      // 無視
    }
    this.audioCtx = null;
    this.stream = null;
    this.source = null;
    this.analyser = null;
    this.monitorGain = null;
    this.data = null;
  }
}
