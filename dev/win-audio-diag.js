/* Windows 切り分け用: Obsidian の開発者ツール Console にそのまま貼って実行。
   録音プラグインと同じ手順で「どこで音が消えるか」を段階的に測る。 */
(async () => {
  const log = (...a) => console.log("%c[rmr-diag]", "color:#7c6cf0", ...a);
  const getRemote = () => {
    const req = window.require;
    try { const e = req("electron"); if (e && e.remote) return e.remote; } catch {}
    try { return req("@electron/remote"); } catch {}
    return null;
  };

  const ctx = new AudioContext();
  log("AudioContext 生成直後:", ctx.state, "/ sampleRate", ctx.sampleRate);
  await ctx.resume().catch(() => {});
  log("resume 後:", ctx.state);

  const meter = (node) => {
    const an = ctx.createAnalyser();
    an.fftSize = 256;
    const d = new Uint8Array(an.frequencyBinCount);
    node.connect(an);
    return () => {
      an.getByteFrequencyData(d);
      let s = 0;
      for (const v of d) s += v;
      return (s / d.length / 255).toFixed(4);
    };
  };
  const sample = async (name, read, n = 8) => {
    const vals = [];
    for (let i = 0; i < n; i++) {
      await new Promise((r) => setTimeout(r, 250));
      vals.push(read());
    }
    log(name, "→", vals.join(" "));
  };
  const tinfo = (ts) => ts.map((t) => ({ label: t.label, muted: t.muted, enabled: t.enabled, state: t.readyState }));

  // ---- 1) マイク -------------------------------------------------------
  try {
    const mic = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
    log("マイク track:", tinfo(mic.getAudioTracks()));
    const src = ctx.createMediaStreamSource(new MediaStream(mic.getAudioTracks()));
    log("↓ 何か喋ってください（2秒）");
    await sample("マイクのレベル", meter(src));
    mic.getTracks().forEach((t) => t.stop());
  } catch (e) {
    log("マイク取得に失敗:", e.name, e.message);
  }

  // ---- 2) システム音（ループバック） ----------------------------------
  try {
    const remote = getRemote();
    if (!remote) throw new Error("electron remote が取れません");
    const session = remote.getCurrentWebContents ? remote.getCurrentWebContents().session : remote.session.defaultSession;
    const dc = remote.desktopCapturer;
    const handler = (_req, cb) => {
      Promise.resolve(dc.getSources({ types: ["screen"] }))
        .then((s) => cb({ video: s[0], audio: "loopback" }))
        .catch(() => cb({}));
    };
    try { session.setDisplayMediaRequestHandler(handler, { useSystemPicker: false }); }
    catch { session.setDisplayMediaRequestHandler(handler); }

    const sys = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    session.setDisplayMediaRequestHandler(null);
    log("システム音 track:", tinfo(sys.getAudioTracks()));

    const src2 = ctx.createMediaStreamSource(new MediaStream(sys.getAudioTracks()));
    const read2 = meter(src2);
    log("↓ 音楽や動画を鳴らしてください（2秒・video track 停止前）");
    await sample("システム音（video 停止前）", read2);

    sys.getVideoTracks().forEach((t) => t.stop()); // ← プラグインがやっている操作
    log("video track を停止 → audio track:", tinfo(sys.getAudioTracks()));
    log("↓ 鳴らしたまま（2秒・video track 停止後）");
    await sample("システム音（video 停止後）", read2);

    sys.getTracks().forEach((t) => t.stop());
  } catch (e) {
    log("システム音取得に失敗:", e.name, e.message);
  }

  log("AudioContext 最終状態:", ctx.state);
  await ctx.close();
  log("完了");
})();
