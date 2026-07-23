/* Windows(Web Audio) 経路の AGC/リミッターを、実際のノードグラフで検証する。
   Obsidian の開発者ツール Console に貼るか、obsidian eval で実行する。
   合成した正弦波を MediaStream 化してソースにするので、マイク権限も実機 Windows も不要
   （グラフの形は webCapture.ts と同一）。結果を JSON で返す。 */
(async () => {
  const AGC_TARGET_RMS = 0.1, AGC_GATE_RMS = 0.0079, AGC_MIN_GAIN = 0.125, AGC_MAX_GAIN = 4.0;
  const nextAgcState = (rms, prev, dt) => {
    if (rms > AGC_GATE_RMS) {
      const desired = Math.min(Math.max(AGC_TARGET_RMS / rms, AGC_MIN_GAIN), AGC_MAX_GAIN);
      if (!prev.locked) return { gain: desired, locked: true };
      const tau = desired < prev.gain ? 0.4 : 3.0;
      return { gain: prev.gain + (desired - prev.gain) * (1 - Math.exp(-dt / tau)), locked: true };
    }
    const gain = prev.gain + (1 - prev.gain) * (1 - Math.exp(-dt / 0.8));
    return Math.abs(gain - 1) < 0.05 ? { gain: 1, locked: false } : { gain, locked: prev.locked };
  };
  const rms = (b) => { let s = 0; for (const v of b) s += v * v; return Math.sqrt(s / b.length); };

  /** amplitude の正弦波を webCapture.ts と同じチェーンに通し、AGC を ticks 回まわす。 */
  const run = async (amplitude, ticks, useAgc) => {
    const ctx = new AudioContext();
    await ctx.resume();
    // 合成ソース → MediaStream（getUserMedia/ループバックの代わり）
    const osc = ctx.createOscillator();
    osc.frequency.value = 440;
    const amp = ctx.createGain();
    amp.gain.value = amplitude;
    const srcDest = ctx.createMediaStreamDestination();
    osc.connect(amp); amp.connect(srcDest); osc.start();

    // ここから webCapture.ts と同じ: source → gain → agcGain → limiter → dest
    const node = ctx.createMediaStreamSource(new MediaStream(srcDest.stream.getAudioTracks()));
    const gain = ctx.createGain(); gain.gain.value = 1;
    const analyser = ctx.createAnalyser(); analyser.fftSize = 256;
    const agcGain = ctx.createGain(); agcGain.gain.value = 1;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -1; limiter.knee.value = 0; limiter.ratio.value = 20;
    limiter.attack.value = 0.003; limiter.release.value = 0.1;
    const dest = ctx.createMediaStreamDestination();
    node.connect(gain); gain.connect(analyser); gain.connect(agcGain);
    agcGain.connect(limiter); limiter.connect(dest);
    const outAn = ctx.createAnalyser(); outAn.fftSize = 256; limiter.connect(outAn);

    const inBuf = new Float32Array(256), outBuf = new Float32Array(256);
    let state = { gain: 1, locked: false };
    let inRms = 0, outRms = 0, outPeak = 0;
    for (let i = 0; i < ticks; i++) {
      await new Promise((r) => setTimeout(r, 100));
      analyser.getFloatTimeDomainData(inBuf);
      inRms = rms(inBuf);
      if (useAgc) {
        state = nextAgcState(inRms, state, 0.1);
        agcGain.gain.setTargetAtTime(state.gain, ctx.currentTime, 0.05);
      }
      outAn.getFloatTimeDomainData(outBuf);
      outRms = rms(outBuf);
      for (const v of outBuf) outPeak = Math.max(outPeak, Math.abs(v));
    }
    const r = {
      amplitude, useAgc,
      inRms: +inRms.toFixed(4),
      agcGain: +state.gain.toFixed(3),
      outRms: +outRms.toFixed(4),
      outPeak: +outPeak.toFixed(4),
      dbGain: +(20 * Math.log10((outRms || 1e-9) / (inRms || 1e-9))).toFixed(1),
    };
    await ctx.close();
    return r;
  };

  const results = {
    "小音量+AGC(持ち上がるか)": await run(0.014, 25, true),
    "小音量+AGCなし(素通しか)": await run(0.014, 10, false),
    "過大入力+リミッター(抑えるか)": await run(1.0, 15, true),
  };
  return JSON.stringify(results, null, 2);
})();
