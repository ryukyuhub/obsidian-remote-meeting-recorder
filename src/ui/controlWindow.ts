import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { getElectronRemote } from "../platform/electron";
import { CONTROL_WINDOW_HTML } from "./controlWindowHtml";

/* eslint-disable @typescript-eslint/no-explicit-any -- Electron の remote API（BrowserWindow/ipcMain 等）は型情報が乏しく any 経由で扱う */

export interface ControlWindowConfig {
  source: string;
  accent: string;
  label: string;
}

const CH_STOP = "rmr:stop";
const CH_LEVEL = "rmr:level";
const CH_TICK = "rmr:tick";
const CH_CONFIG = "rmr:config";

/**
 * 常時前面ミニ制御ウィンドウ（設計書 §9.4・§14.3）。
 * frameless/transparent/alwaysOnTop の BrowserWindow を remote 経由で生成し、
 * 会議アプリの前面に波形＋停止を浮かべる。レベルは親のマイクタップから forward。
 * unload/停止で確実に破棄（ゾンビ窓防止）。remote 不在環境では open()=false。
 */
export class ControlWindowManager {
  private win: any = null;
  private ipcMain: any = null;
  private stopHandler: ((...args: any[]) => void) | null = null;
  private levelTimer: number | null = null;

  open(
    config: ControlWindowConfig,
    onStop: () => void,
    getLevel: () => number
  ): boolean {
    const remote = getElectronRemote() as any;
    if (!remote?.BrowserWindow) return false;
    this.close(); // 既存があれば閉じる

    // HTML はバンドル埋め込み → 一時ファイルへ書き出して file: で読む（同梱漏れに強い）
    const htmlPath = writeControlWindowHtml();
    if (!htmlPath) return false;

    const W = 340;
    const H = 96;
    let x: number | undefined;
    let y: number | undefined;
    try {
      const wa = remote.screen?.getPrimaryDisplay?.().workAreaSize;
      if (wa) {
        x = Math.floor(wa.width / 2 - W / 2);
        y = wa.height - H - 40;
      }
    } catch {
      /* 位置は既定に任せる */
    }

    try {
      this.win = new remote.BrowserWindow({
        width: W,
        height: H,
        x,
        y,
        frame: false,
        transparent: true,
        backgroundColor: "#00000000",
        hasShadow: false,
        alwaysOnTop: true,
        resizable: false,
        skipTaskbar: true,
        fullscreenable: false,
        minimizable: false,
        maximizable: false,
        webPreferences: {
          nodeIntegration: true,
          contextIsolation: false,
          backgroundThrottling: false,
        },
      });
    } catch {
      this.win = null;
      return false;
    }

    try {
      this.win.setAlwaysOnTop(true, "screen-saver");
      this.win.setVisibleOnAllWorkspaces?.(true, { visibleOnFullScreen: true });
    } catch {
      /* 非対応なら無視 */
    }

    this.win.loadFile(htmlPath);
    this.win.webContents.on("did-finish-load", () => this.safeSend(CH_CONFIG, config));

    // 停止（子 → 親）: ipcMain 経由で親レンダラのハンドラを呼ぶ
    this.ipcMain = remote.ipcMain ?? null;
    if (this.ipcMain) {
      this.stopHandler = () => onStop();
      try {
        this.ipcMain.on(CH_STOP, this.stopHandler);
      } catch {
        /* noop */
      }
    }

    // レベル送出（親 → 子・~16fps）
    this.levelTimer = window.setInterval(() => this.safeSend(CH_LEVEL, getLevel()), 60);

    this.win.on("closed", () => this.cleanup());
    return true;
  }

  tick(elapsedSec: number): void {
    this.safeSend(CH_TICK, Math.floor(elapsedSec));
  }

  private safeSend(channel: string, data: unknown): void {
    try {
      if (this.win && !this.win.isDestroyed?.()) this.win.webContents.send(channel, data);
    } catch {
      /* 破棄済み等は無視 */
    }
  }

  close(): void {
    try {
      if (this.win && !this.win.isDestroyed?.()) this.win.close();
    } catch {
      /* noop */
    }
    this.cleanup();
  }

  /** unload 時に確実に破棄。 */
  destroy(): void {
    try {
      if (this.win && !this.win.isDestroyed?.()) this.win.destroy();
    } catch {
      /* noop */
    }
    this.cleanup();
  }

  private cleanup(): void {
    if (this.levelTimer) {
      window.clearInterval(this.levelTimer);
      this.levelTimer = null;
    }
    if (this.ipcMain && this.stopHandler) {
      try {
        this.ipcMain.removeListener(CH_STOP, this.stopHandler);
      } catch {
        /* noop */
      }
    }
    this.stopHandler = null;
    this.win = null;
  }
}

/** 埋め込み HTML を一時ファイルへ書き出してパスを返す。失敗時は null。 */
function writeControlWindowHtml(): string | null {
  try {
    const p = path.join(os.tmpdir(), "rmr-control-window.html");
    fs.writeFileSync(p, CONTROL_WINDOW_HTML);
    return p;
  } catch {
    return null;
  }
}
