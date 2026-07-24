/* Windows 実機検証（R4）: Obsidian の開発者ツール Console にそのまま貼って実行。
   録音プラグインと同じ経路で「どこで音が消えるか / レベル補正が効くか」を段階的に測り、
   最後に 1 行の JSON サマリを出す。★その JSON を貼り返してもらえれば解析できる★

   検証すること（リファクタ調査 §4.3 の実機チェックリスト）:
     [A] 環境: MediaRecorder の mp4/AAC 対応・AudioEncoder・Chromium 版
     [B] マイク取得とレベル
     [C] システム音（WASAPI ループバック）取得とレベル（video track 停止前後）
     [D] 0.7.x の取り込み時正規化が実信号で -16 dBFS 近傍へ収束するか
     [E] 出力音量を変えたとき: 生レベルは動いても正規化後が安定しているか
     [F] 既定出力デバイスを切り替えたとき: トラックが生きるか（ended / 無音 / 継続）

   実行時間は約 75 秒。途中で指示（音を鳴らす・音量を変える・デバイスを切替える）が出る。 */
(async () => {
  const log = (...a) => console.log("%c[rmr-diag]", "color:#7c6cf0;font-weight:bold", ...a);
  const summary = { ts: new Date().toISOString(), ua: navigator.userAgent.match(/Chrome\/[0-9.]+/)?.[0] };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const db = (v) => (v > 0 ? (20 * Math.log10(v)).toFixed(1) : "-inf");

  // ---- [A] 環境 --------------------------------------------------------
  summary.mediaRecorder = {
    mp4_aac: typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported("audio/mp4;codecs=mp4a.40.2"),
    mp4: typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported("audio/mp4"),
    webm_opus: typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported("audio/webm;codecs=opus"),
  };
  try {
    summary.audioEncoder = typeof AudioEncoder !== "undefined"
      ? { aac: (await AudioEncoder.isConfigSupported({ codec: "mp4a.40.2", sampleRate: 48000, numberOfChannels: 1, bitrate: 96000 })).supported,
          opus: (await AudioEncoder.isConfigSupported({ codec: "opus", sampleRate: 48000, numberOfChannels: 1, bitrate: 96000 })).supported }
      : null;
  } catch { summary.audioEncoder = "error"; }
  log("[A] 環境:", JSON.stringify(summary.mediaRecorder), JSON.stringify(summary.audioEncoder));

  const getRemote = () => {
    const req = window.require;
    try { const e = req("electron"); if (e && e.remote) return e.remote; } catch {}
    try { return req("@electron/remote"); } catch {}
    return null;
  };

  const ctx = new AudioContext();
  await ctx.resume().catch(() => {});
  summary.audioContext = { state: ctx.state, sampleRate: ctx.sampleRate };
  log("AudioContext:", ctx.state, "/", ctx.sampleRate, "Hz");

  const rmsMeter = (node) => {
    const an = ctx.createAnalyser();
    an.fftSize = 2048;
    const d = new Float32Array(an.fftSize);
    node.connect(an);
    return () => {
      an.getFloatTimeDomainData(d);
      let s = 0;
      for (let i = 0; i < d.length; i++) s += d[i] * d[i];
      return Math.sqrt(s / d.length);
    };
  };

  // ---- [B] マイク ------------------------------------------------------
  try {
    const mic = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false,
    });
    const read = rmsMeter(ctx.createMediaStreamSource(new MediaStream(mic.getAudioTracks())));
    log("[B] ↓ 何か喋ってください（3 秒）");
    let peak = 0;
    for (let i = 0; i < 12; i++) { await sleep(250); peak = Math.max(peak, read()); }
    summary.micPeakDb = db(peak);
    log("[B] マイク ピーク:", summary.micPeakDb, "dBFS");
    mic.getTracks().forEach((t) => t.stop());
  } catch (e) { summary.micError = `${e.name}: ${e.message}`; log("[B] マイク失敗:", e); }

  // ---- [C] システム音（ループバック）取得 ------------------------------
  let sys = null;
  try {
    const remote = getRemote();
    if (!remote) throw new Error("electron remote が取れません");
    const session = remote.getCurrentWebContents ? remote.getCurrentWebContents().session : remote.session.defaultSession;
    const dc = remote.desktopCapturer;
    const handler = (_req, cb) => {
      Promise.resolve(dc.getSources({ types: ["screen"] }))
        .then((s) => cb({ video: s[0], audio: "loopback" })).catch(() => cb({}));
    };
    try { session.setDisplayMediaRequestHandler(handler, { useSystemPicker: false }); }
    catch { session.setDisplayMediaRequestHandler(handler); }
    sys = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    session.setDisplayMediaRequestHandler(null);
    sys.getVideoTracks().forEach((t) => t.stop()); // プラグインと同じ（音声のみ残す）
    const tr = sys.getAudioTracks()[0];
    summary.loopback = { label: tr?.label, muted: tr?.muted, state: tr?.readyState };
    tr?.addEventListener("ended", () => { summary.loopbackEnded = true; log("[F] ★ loopback track が ended になりました"); });
    log("[C] ループバック取得 OK:", JSON.stringify(summary.loopback));
  } catch (e) {
    summary.loopbackError = `${e.name}: ${e.message}`;
    log("[C] システム音失敗:", e);
  }

  // ---- [D][E][F] 正規化チェーン（プラグイン 0.7.x と同じ定数）を通して観測 ----
  if (sys) {
    const src = ctx.createMediaStreamSource(new MediaStream(sys.getAudioTracks()));
    const agcGain = ctx.createGain();            // AutoGain 相当（この診断では素通し=1.0）
    const normGain = ctx.createGain();           // 取り込み時正規化
    const lim = ctx.createDynamicsCompressor();
    lim.threshold.value = -1; lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = 0.003; lim.release.value = 0.1;
    const readIn = rmsMeter(src);                // 生（ループバック直後）
    src.connect(agcGain); agcGain.connect(normGain); normGain.connect(lim);
    const readOut = rmsMeter(lim);               // 正規化＋リミッター後

    // nextNormalizerState と同じアルゴリズム（src/recorder/agc.ts）
    const T = 0.158, G = 0.0079, MIN = 0.125, MAX = 8.0, WARM = 1.5, TAU = 1.0, FB = 10, SIL = 0.0002;
    let st = { gain: 1, ge: 0, gs: 0, ae: 0, as: 0 };
    const step = (rms, dt) => {
      const n = { gain: st.gain, ge: st.ge, gs: st.gs, ae: st.ae + rms * rms * dt, as: st.as + dt };
      if (rms > G) { n.ge += rms * rms * dt; n.gs += dt; }
      let m;
      if (n.gs >= WARM) m = Math.sqrt(n.ge / n.gs);
      else if (n.as >= FB) { m = Math.sqrt(n.ae / n.as); if (m < SIL) { st = n; return; } }
      else { st = n; return; }
      const d = Math.min(Math.max(T / m, MIN), MAX);
      n.gain = st.gain + (d - st.gain) * (1 - Math.exp(-dt / TAU));
      st = n;
    };

    log("[D] ↓ 音楽/動画を通常音量で鳴らし続けてください（20 秒・正規化の収束を測ります）");
    const timeline = [];
    for (let i = 0; i < 200; i++) {
      const rin = readIn(); step(rin, 0.1);
      normGain.gain.setTargetAtTime(st.gain, ctx.currentTime, 0.05);
      if (i % 10 === 0) timeline.push({ t: i / 10, in: db(rin), gain: +st.gain.toFixed(2), out: db(readOut()) });
      await sleep(100);
    }
    summary.normalize20s = timeline.slice(-3);
    log("[D] 20 秒後: 入力", timeline.at(-1).in, "dBFS / ゲイン", timeline.at(-1).gain, "/ 出力", timeline.at(-1).out, "dBFS");

    log("[E] ↓ Windows の音量を半分くらいに下げて、鳴らし続けてください（15 秒）");
    const volTl = [];
    for (let i = 0; i < 150; i++) {
      const rin = readIn(); step(rin, 0.1);
      normGain.gain.setTargetAtTime(st.gain, ctx.currentTime, 0.05);
      if (i % 25 === 0) volTl.push({ t: i / 10, in: db(rin), gain: +st.gain.toFixed(2), out: db(readOut()) });
      await sleep(100);
    }
    summary.volumeChange15s = volTl;
    log("[E] 音量変更中の推移:", JSON.stringify(volTl));

    log("[F] ↓ 既定の出力デバイスを切り替えてください（スピーカー⇔イヤホン等・15 秒。無ければ何もしなくて OK）");
    const swTl = [];
    for (let i = 0; i < 150; i++) {
      const rin = readIn();
      if (i % 25 === 0) swTl.push({ t: i / 10, in: db(rin), trackState: sys.getAudioTracks()[0]?.readyState });
      await sleep(100);
    }
    summary.deviceSwitch15s = swTl;
    summary.loopbackEnded = summary.loopbackEnded ?? false;
    log("[F] 切替中の推移:", JSON.stringify(swTl));

    sys.getTracks().forEach((t) => t.stop());
  }

  await ctx.close();
  log("======== 以下の 1 行をコピーして報告してください ========");
  console.log(JSON.stringify(summary));
})();
