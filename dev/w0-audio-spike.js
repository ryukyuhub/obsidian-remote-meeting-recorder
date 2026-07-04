/*
 * W0 疎通スパイク — Windows / Obsidian でシステム音声＋マイクが録れるかを実機判定する。
 *
 * 使い方（Windows の Obsidian 上で）:
 *   1. Ctrl+Shift+I で開発者ツールを開く
 *   2. Console タブを開く
 *   3. このファイルの中身を全部コピーして貼り付け、Enter
 *   4. 会議アプリ等で音を鳴らしながら実行するとシステム音声の有無が分かる
 *   5. 最後に表示される [W0] 結果サマリ を丸ごとコピーして報告してください
 *
 * このスクリプトはプラグインを一切変更しません（使い捨ての検証）。
 * 途中でピッカー（画面共有ダイアログ）が出たかどうかも報告してください。
 */
(async () => {
  const R = {
    remote: null,
    remotePath: null,
    session: null,
    methodC_system: null,
    methodA_system: null,
    mic: null,
    mime_mp4: null,
    mime_mp4_aac: null,
    mime_webm_opus: null,
    mime_webm: null,
    mixRecordBytes: null,
    notes: [],
  };
  const log = (...a) => console.log("[W0]", ...a);
  const stopTracks = (s) => { try { s && s.getTracks().forEach((t) => t.stop()); } catch (e) { /* ignore */ } };

  // --- 1. electron remote 取得 ---------------------------------------------
  let remote = null;
  try {
    const req = window.require;
    if (typeof req !== "function") throw new Error("window.require が無い");
    try {
      const e = req("electron");
      if (e && e.remote) { remote = e.remote; R.remotePath = "electron.remote"; }
    } catch (e) { /* try next */ }
    if (!remote) {
      try { remote = req("@electron/remote"); R.remotePath = "@electron/remote"; } catch (e) { /* noop */ }
    }
  } catch (e) {
    R.notes.push("require アクセス不可: " + e.message);
  }
  R.remote = remote ? "OK (" + R.remotePath + ")" : "NG（メイン session にアクセスできない）";
  log("remote:", R.remote);

  // --- 2. メイン session 取得 ----------------------------------------------
  let session = null;
  if (remote) {
    try {
      session = remote.getCurrentWebContents ? remote.getCurrentWebContents().session : null;
    } catch (e) { /* try default */ }
    if (!session) {
      try { session = remote.session && remote.session.defaultSession; } catch (e) { /* noop */ }
    }
  }
  R.session = session ? "OK" : "NG";
  log("session:", R.session);

  // --- 3. 方式C: setDisplayMediaRequestHandler(audio:'loopback') + getDisplayMedia ---
  if (session && remote) {
    try {
      const handler = (request, callback) => {
        try {
          remote.desktopCapturer
            .getSources({ types: ["screen"] })
            .then((sources) => callback({ video: sources[0], audio: "loopback" }))
            .catch((err) => { R.notes.push("方式C getSources 失敗: " + err.message); callback({}); });
        } catch (err) {
          R.notes.push("方式C handler 例外: " + err.message);
          try { callback({}); } catch (e) { /* noop */ }
        }
      };
      try { session.setDisplayMediaRequestHandler(handler, { useSystemPicker: false }); }
      catch (e) { session.setDisplayMediaRequestHandler(handler); } // 古い署名フォールバック

      log("方式C: getDisplayMedia を呼びます（ここでダイアログが出たら報告してください）…");
      const dm = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      const at = dm.getAudioTracks();
      R.methodC_system = at.length > 0
        ? "OK（audioトラック " + at.length + "本: " + (at[0].label || "無名") + "）"
        : "NG（audioトラックが空）";
      stopTracks(dm);
    } catch (e) {
      R.methodC_system = "NG（例外: " + e.name + ": " + e.message + "）";
    } finally {
      try { session.setDisplayMediaRequestHandler(null); } catch (e) { /* noop */ }
    }
  } else {
    R.methodC_system = "スキップ（session 無し）";
  }
  log("方式C system:", R.methodC_system);

  // --- 4. 方式A: desktopCapturer + getUserMedia(mandatory chromeMediaSource) ---
  if (remote) {
    try {
      const sources = await remote.desktopCapturer.getSources({ types: ["screen"] });
      if (!sources || sources.length === 0) throw new Error("screen ソースが無い");
      const id = sources[0].id;
      const ua = await navigator.mediaDevices.getUserMedia({
        audio: { mandatory: { chromeMediaSource: "desktop", chromeMediaSourceId: id } },
        video: { mandatory: { chromeMediaSource: "desktop", chromeMediaSourceId: id } },
      });
      const at = ua.getAudioTracks();
      R.methodA_system = at.length > 0
        ? "OK（audioトラック " + at.length + "本）"
        : "NG（audioトラックが空）";
      stopTracks(ua);
    } catch (e) {
      R.methodA_system = "NG（例外: " + e.name + ": " + e.message + "）";
    }
  } else {
    R.methodA_system = "スキップ（remote 無し）";
  }
  log("方式A system:", R.methodA_system);

  // --- 5. マイク -----------------------------------------------------------
  let micStream = null;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true } });
    R.mic = "OK（" + (micStream.getAudioTracks()[0]?.label || "無名") + "）";
  } catch (e) {
    R.mic = "NG（例外: " + e.name + ": " + e.message + "）";
    R.notes.push("マイク不可の場合: Windows 設定 > プライバシー > マイク > 「デスクトップ アプリにマイクへのアクセスを許可」を確認");
  }
  log("mic:", R.mic);

  // --- 6. MediaRecorder mime 対応 ------------------------------------------
  const sup = (t) => { try { return MediaRecorder.isTypeSupported(t) ? "OK" : "NG"; } catch (e) { return "?"; } };
  R.mime_mp4 = sup("audio/mp4");
  R.mime_mp4_aac = sup("audio/mp4;codecs=mp4a.40.2");
  R.mime_webm_opus = sup("audio/webm;codecs=opus");
  R.mime_webm = sup("audio/webm");
  log("mime mp4/mp4-aac/webm-opus/webm:", R.mime_mp4, R.mime_mp4_aac, R.mime_webm_opus, R.mime_webm);

  // --- 7. system+mic を Web Audio でミックス → 3秒録音 ----------------------
  try {
    // system は取れた方式で再取得（C 優先、無ければ A）
    let sysStream = null;
    if (session && remote && String(R.methodC_system).startsWith("OK")) {
      const handler = (req2, cb) =>
        remote.desktopCapturer.getSources({ types: ["screen"] })
          .then((s) => cb({ video: s[0], audio: "loopback" })).catch(() => cb({}));
      try { session.setDisplayMediaRequestHandler(handler, { useSystemPicker: false }); }
      catch (e) { session.setDisplayMediaRequestHandler(handler); }
      sysStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      try { session.setDisplayMediaRequestHandler(null); } catch (e) { /* noop */ }
    } else if (remote && String(R.methodA_system).startsWith("OK")) {
      const s = await remote.desktopCapturer.getSources({ types: ["screen"] });
      sysStream = await navigator.mediaDevices.getUserMedia({
        audio: { mandatory: { chromeMediaSource: "desktop", chromeMediaSourceId: s[0].id } },
        video: { mandatory: { chromeMediaSource: "desktop", chromeMediaSourceId: s[0].id } },
      });
    }
    if (!micStream) micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true } });

    if (sysStream || micStream) {
      const ctx = new AudioContext();
      const dest = ctx.createMediaStreamDestination();
      if (sysStream && sysStream.getAudioTracks().length)
        ctx.createMediaStreamSource(new MediaStream(sysStream.getAudioTracks())).connect(dest);
      if (micStream && micStream.getAudioTracks().length)
        ctx.createMediaStreamSource(new MediaStream(micStream.getAudioTracks())).connect(dest);

      const mime = R.mime_mp4 === "OK" ? "audio/mp4"
        : R.mime_webm_opus === "OK" ? "audio/webm;codecs=opus" : "audio/webm";
      const chunks = [];
      const rec = new MediaRecorder(dest.stream, { mimeType: mime });
      rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      await new Promise((resolve) => {
        rec.onstop = resolve;
        rec.start(1000); // timeslice 1s（逐次追記の実挙動確認）
        setTimeout(() => { try { rec.stop(); } catch (e) { resolve(); } }, 3000);
      });
      const bytes = chunks.reduce((n, b) => n + b.size, 0);
      R.mixRecordBytes = mime + " / " + bytes + " bytes / " + chunks.length + " チャンク";
      stopTracks(sysStream);
      try { ctx.close(); } catch (e) { /* noop */ }
    } else {
      R.mixRecordBytes = "スキップ（system も mic も取れず）";
    }
  } catch (e) {
    R.mixRecordBytes = "NG（例外: " + e.name + ": " + e.message + "）";
  }
  stopTracks(micStream);
  log("mix録音:", R.mixRecordBytes);

  // --- 結果サマリ ----------------------------------------------------------
  console.log("\n========== [W0] 結果サマリ（このブロックを丸ごと報告してください） ==========");
  console.table(R);
  console.log("notes:", R.notes);
  console.log("========================================================================\n");
  window.__W0 = R;
  return R;
})();
