/**
 * ミニ制御ウィンドウの HTML（設計書 §9.4）。
 *
 * 外部ファイル（control-window.html）を同梱して loadFile する方式だと、
 * BRAT 配布や自己配布は main.js / manifest.json / styles.css の 3 点しか取得しないため
 * HTML が欠落し、透明フレームレス窓が空ロードで見えなくなる（＝バーが出ない）。
 * これを避けるため HTML はバンドルに埋め込み、起動時に一時ファイルへ書き出して loadFile する。
 * data: URL ではなく file: にするのは、ページ内 require("electron") の nodeIntegration を保つため。
 */
export const CONTROL_WINDOW_HTML = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      * {
        box-sizing: border-box;
      }
      html,
      body {
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
        align-items: center;
        gap: 10px;
        padding: 0 14px;
        box-shadow: 0 8px 28px rgba(0, 0, 0, 0.45);
        -webkit-app-region: drag;
      }
      #left {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-shrink: 0;
      }
      #dot {
        width: 10px;
        height: 10px;
        border-radius: 50%;
        background: #e5484d;
        animation: pulse 1.4s infinite;
      }
      @keyframes pulse {
        0%,
        100% {
          opacity: 1;
        }
        50% {
          opacity: 0.3;
        }
      }
      #timer {
        color: #fff;
        font-variant-numeric: tabular-nums;
        font-size: 15px;
        font-weight: 600;
        min-width: 46px;
      }
      #wave {
        flex: 1;
        min-width: 0;
        height: 40px;
      }
      #msg {
        flex: 1;
        min-width: 0;
        color: #bbb;
        font-size: 12px;
        text-align: center;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        display: none;
      }
      #stop {
        -webkit-app-region: no-drag;
        flex-shrink: 0;
        cursor: pointer;
        width: 26px;
        height: 26px;
        padding: 0;
        line-height: 1;
        border: none;
        border-radius: 7px;
        background: #e5484d;
        color: #fff;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 10px;
      }
      #stop:hover {
        background: #f2555a;
      }
    </style>
  </head>
  <body>
    <div id="pill">
      <div id="left"><div id="dot"></div><div id="timer">0:00</div></div>
      <canvas id="wave"></canvas>
      <div id="msg">システム音声を録音中</div>
      <button id="stop" title="停止">■</button>
    </div>
    <script>
      const { ipcRenderer } = require("electron");
      const canvas = document.getElementById("wave");
      const msg = document.getElementById("msg");
      const timerEl = document.getElementById("timer");
      const stopBtn = document.getElementById("stop");
      let accent = "#7c6cf0";
      let source = "both";
      let level = 0;
      const bars = new Array(48).fill(0);

      stopBtn.addEventListener("click", () => ipcRenderer.send("rmr:stop"));

      ipcRenderer.on("rmr:config", (_e, cfg) => {
        if (cfg && cfg.accent) accent = cfg.accent;
        source = (cfg && cfg.source) || "both";
        const meter = source !== "system";
        canvas.style.display = meter ? "block" : "none";
        msg.style.display = meter ? "none" : "block";
      });
      ipcRenderer.on("rmr:level", (_e, v) => {
        level = v || 0;
      });
      ipcRenderer.on("rmr:tick", (_e, sec) => {
        timerEl.textContent = fmt(sec);
      });

      function fmt(s) {
        s = Math.max(0, s | 0);
        const h = (s / 3600) | 0,
          m = ((s % 3600) / 60) | 0,
          x = s % 60;
        const p = (n) => String(n).padStart(2, "0");
        return h > 0 ? \`\${h}:\${p(m)}:\${p(x)}\` : \`\${m}:\${p(x)}\`;
      }

      function draw() {
        const dpr = window.devicePixelRatio || 1;
        const w = canvas.clientWidth * dpr,
          h = canvas.clientHeight * dpr;
        if (canvas.width !== w || canvas.height !== h) {
          canvas.width = w;
          canvas.height = h;
        }
        const ctx = canvas.getContext("2d");
        ctx.clearRect(0, 0, w, h);
        if (source !== "system") {
          const shaped = Math.min(1, Math.pow(level, 0.5) + Math.random() * 0.02);
          bars.push(shaped);
          if (bars.length > 48) bars.shift();
          const gap = 2 * dpr,
            bw = (w - gap * 47) / 48,
            mid = h / 2;
          for (let i = 0; i < bars.length; i++) {
            const v = bars[i];
            const bh = Math.max(2 * dpr, v * h * 0.9);
            ctx.globalAlpha = 0.35 + v * 0.65;
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
