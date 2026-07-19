/**
 * ミニ制御ウィンドウの HTML（設計書 §9.4）。
 *
 * 外部ファイル（control-window.html）を同梱して loadFile する方式だと、
 * BRAT 配布や自己配布は main.js / manifest.json / styles.css の 3 点しか取得しないため
 * HTML が欠落し、透明フレームレス窓が空ロードで見えなくなる（＝バーが出ない）。
 * これを避けるため HTML はバンドルに埋め込み、起動時に一時ファイルへ書き出して loadFile する。
 * data: URL ではなく file: にするのは、ページ内 require("electron") の nodeIntegration を保つため。
 *
 * 縦型ピル: 上段（録音ドット＋経過＋停止）＋ ソース行（ラベル＋フェーダー＋メーター）。
 * source=both は system/mic の 2 行、単体は 1 行。手動ミキサー時のみフェーダーを出す。
 */
export const CONTROL_WINDOW_HTML = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      * { box-sizing: border-box; }
      html, body {
        height: 100%;
        margin: 0;
        padding: 0;
        background: transparent;
        overflow: hidden;
        -webkit-user-select: none;
        user-select: none;
        font-family: -apple-system, system-ui, sans-serif;
      }
      #pill {
        margin: 8px;
        height: calc(100% - 16px);
        border-radius: 16px;
        background: rgba(28, 28, 32, 0.92);
        display: flex;
        flex-direction: column;
        justify-content: center;
        gap: 6px;
        padding: 8px 14px;
        box-shadow: 0 8px 28px rgba(0, 0, 0, 0.45);
        -webkit-app-region: drag;
      }
      #top { display: flex; align-items: center; gap: 8px; }
      #dot {
        width: 10px; height: 10px; border-radius: 50%;
        background: #e5484d; animation: pulse 1.4s infinite; flex-shrink: 0;
      }
      @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }
      #timer {
        color: #fff; font-variant-numeric: tabular-nums;
        font-size: 15px; font-weight: 600; min-width: 46px;
      }
      #spacer { flex: 1; }
      #stop {
        -webkit-app-region: no-drag; flex-shrink: 0; cursor: pointer;
        width: 26px; height: 26px; padding: 0; line-height: 1; border: none;
        border-radius: 7px; background: #e5484d; color: #fff;
        display: flex; align-items: center; justify-content: center; font-size: 10px;
      }
      #stop:hover { background: #f2555a; }
      #rows { display: flex; flex-direction: column; gap: 4px; }
      .srow { display: flex; align-items: center; gap: 8px; height: 30px; }
      .slabel { flex: 0 0 30px; color: #cfcfd6; font-size: 11px; }
      .sfader {
        -webkit-app-region: no-drag; flex: 1; min-width: 0; height: 16px; margin: 0;
      }
      .sdb {
        flex: 0 0 28px; text-align: right; color: #9a9aa4;
        font-size: 10px; font-variant-numeric: tabular-nums;
      }
      .smeter { flex: 0 0 78px; height: 20px; }
      .smeter.wide { flex: 1; } /* Auto モード（フェーダー無し）はメーターを広く */
    </style>
  </head>
  <body>
    <div id="pill">
      <div id="top">
        <div id="dot"></div>
        <div id="timer">0:00</div>
        <div id="spacer"></div>
        <button id="stop" title="停止">■</button>
      </div>
      <div id="rows"></div>
    </div>
    <script>
      const { ipcRenderer } = require("electron");
      const timerEl = document.getElementById("timer");
      const rowsEl = document.getElementById("rows");
      document.getElementById("stop").addEventListener("click", () => ipcRenderer.send("rmr:stop"));

      let accent = "#7c6cf0";
      const levels = { system: 0, mic: 0 };
      // source ごとの描画状態（メーターの canvas と履歴）
      const meters = []; // { source, canvas, bars }

      const SRC_LABEL = { system: "Sys", mic: "Mic" };

      ipcRenderer.on("rmr:config", (_e, cfg) => {
        if (cfg && cfg.accent) accent = cfg.accent;
        const source = (cfg && cfg.source) || "both";
        const manual = !!(cfg && cfg.manual);
        const gains = {
          system: (cfg && typeof cfg.systemGainDb === "number") ? cfg.systemGainDb : 0,
          mic: (cfg && typeof cfg.micGainDb === "number") ? cfg.micGainDb : 0,
        };
        const srcs = source === "both" ? ["system", "mic"] : [source];
        buildRows(srcs, manual, gains);
      });
      ipcRenderer.on("rmr:level", (_e, v) => {
        if (v && typeof v.system === "number") levels.system = v.system;
        if (v && typeof v.mic === "number") levels.mic = v.mic;
      });
      ipcRenderer.on("rmr:tick", (_e, sec) => { timerEl.textContent = fmt(sec); });

      const BARS = 20;

      function buildRows(srcs, manual, gains) {
        rowsEl.textContent = "";
        meters.length = 0;
        for (const source of srcs) {
          const row = document.createElement("div");
          row.className = "srow";
          const label = document.createElement("div");
          label.className = "slabel";
          label.textContent = SRC_LABEL[source] || source;
          row.appendChild(label);

          const canvas = document.createElement("canvas");
          canvas.className = "smeter";

          if (manual) {
            // ラベル｜フェーダー｜メーター｜dB
            const fader = document.createElement("input");
            fader.type = "range";
            fader.min = "-24"; fader.max = "24"; fader.step = "1";
            fader.value = String(gains[source] || 0);
            fader.className = "sfader";
            const db = document.createElement("div");
            db.className = "sdb";
            db.textContent = fmtDb(Number(fader.value));
            fader.addEventListener("input", () => {
              const val = Number(fader.value);
              db.textContent = fmtDb(val);
              ipcRenderer.send("rmr:gain", { which: source, db: val });
            });
            row.appendChild(fader);
            row.appendChild(canvas);
            row.appendChild(db);
          } else {
            // Auto モード: フェーダー無し。メーターを広く表示。
            canvas.classList.add("wide");
            row.appendChild(canvas);
          }
          rowsEl.appendChild(row);
          meters.push({ source, canvas, bars: new Array(BARS).fill(0) });
        }
      }

      function fmtDb(db) { return (db > 0 ? "+" : "") + db; }

      function fmt(s) {
        s = Math.max(0, s | 0);
        const h = (s / 3600) | 0, m = ((s % 3600) / 60) | 0, x = s % 60;
        const p = (n) => String(n).padStart(2, "0");
        return h > 0 ? \`\${h}:\${p(m)}:\${p(x)}\` : \`\${m}:\${p(x)}\`;
      }

      function draw() {
        const dpr = window.devicePixelRatio || 1;
        for (const meter of meters) {
          const canvas = meter.canvas;
          const w = canvas.clientWidth * dpr, h = canvas.clientHeight * dpr;
          if (!w || !h) continue;
          if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
          const ctx = canvas.getContext("2d");
          ctx.clearRect(0, 0, w, h);
          const level = levels[meter.source] || 0;
          const shaped = Math.min(1, Math.pow(level, 0.5) + Math.random() * 0.02);
          meter.bars.push(shaped);
          if (meter.bars.length > BARS) meter.bars.shift();
          const gap = 2 * dpr, bw = (w - gap * (BARS - 1)) / BARS, mid = h / 2;
          for (let i = 0; i < meter.bars.length; i++) {
            const v = meter.bars[i];
            const bh = Math.max(2 * dpr, v * h * 0.92);
            ctx.globalAlpha = 0.5 + v * 0.5;
            ctx.fillStyle = accent;
            ctx.fillRect(i * (bw + gap), mid - bh / 2, bw, bh);
          }
          ctx.globalAlpha = 1;
        }
        requestAnimationFrame(draw);
      }
      requestAnimationFrame(draw);
    </script>
  </body>
</html>
`;
