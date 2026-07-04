/* Electron main プロセス API へのアクセス（Obsidian レンダラ）。
 * バージョン差異を吸収するため複数経路を試し、取れなければ null（機能を出さない）。 */

type AnyRecord = Record<string, unknown>;

function nodeRequire(): ((id: string) => AnyRecord) | null {
  const w = window as unknown as { require?: (id: string) => AnyRecord };
  return typeof w.require === "function" ? w.require : null;
}

/**
 * globalShortcut / BrowserWindow など main プロセス側モジュールを提供するオブジェクト。
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

/** レンダラ側 electron（ipcRenderer 等）。 */
export function getElectron(): AnyRecord | null {
  const req = nodeRequire();
  if (!req) return null;
  try {
    return req("electron");
  } catch {
    return null;
  }
}
