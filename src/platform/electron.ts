/* Electron main プロセス API へのアクセス（Obsidian レンダラ）。
 * バージョン差異を吸収するため複数経路を試し、取れなければ null（機能を出さない）。 */

type AnyRecord = Record<string, unknown>;

function nodeRequire(): ((id: string) => AnyRecord) | null {
  const w = window as unknown as { require?: (id: string) => AnyRecord };
  return typeof w.require === "function" ? w.require : null;
}

// --- remote の利用面の最小型（*Like）--------------------------------------------
// remote の実体は Electron/Obsidian の版で差があるため、使う面だけを型で表す。
// 必要になったメンバーはここに追記する（webCapture.ts はキャプチャ専用の型を自前で持つ）。

/** BrowserWindow インスタンスのうち、ミニ制御ウィンドウが使う面。 */
export interface BrowserWindowLike {
  loadFile(filePath: string): unknown;
  webContents: {
    on(event: string, listener: () => void): unknown;
    send(channel: string, data: unknown): unknown;
  };
  on(event: string, listener: () => void): unknown;
  setAlwaysOnTop(flag: boolean, level?: string): void;
  setVisibleOnAllWorkspaces?: (visible: boolean, opts?: { visibleOnFullScreen?: boolean }) => void;
  isDestroyed?: () => boolean;
  close(): void;
  destroy(): void;
}

export interface IpcMainLike {
  on(channel: string, listener: (...args: unknown[]) => void): unknown;
  removeListener(channel: string, listener: (...args: unknown[]) => void): unknown;
}

export interface OpenDialogResultLike {
  canceled: boolean;
  filePaths: string[];
}

/** getElectronRemote() が返すオブジェクトのうち、プラグインが使う面。 */
export interface ElectronRemoteLike {
  BrowserWindow?: new (opts: Record<string, unknown>) => BrowserWindowLike;
  screen?: { getPrimaryDisplay?: () => { workAreaSize?: { width: number; height: number } } };
  ipcMain?: IpcMainLike;
  dialog?: { showOpenDialog(opts: Record<string, unknown>): Promise<OpenDialogResultLike> };
}

/**
 * BrowserWindow / dialog など main プロセス側モジュールを提供するオブジェクト。
 * 1) Obsidian が有効化している electron.remote → 2) @electron/remote パッケージ。
 */
export function getElectronRemote(): AnyRecord | null {
  const req = nodeRequire();
  if (!req) return null;
  try {
    const e = req("electron") as { remote?: AnyRecord };
    if (e && e.remote) return e.remote;
  } catch {
    /* noop */
  }
  try {
    const rm = req("@electron/remote");
    if (rm) return rm;
  } catch {
    /* noop */
  }
  return null;
}
