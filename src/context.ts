import { App, FileSystemAdapter } from "obsidian";
import type { RMRSettings } from "./settings";
import { makePaths, type StatePaths } from "./state/paths";
import { resolveBinPath as resolveBin } from "./util/resolveBin";

/**
 * 録音サブシステムが共有する実行コンテキスト（設計書 §8）。
 * app / 現在の settings / 状態パス / バイナリ解決 / Vault パス解決を束ねる。
 * 設定変更のたびに main.ts が作り直す（settings を live に反映するため）。
 */
export interface RecorderContext {
  app: App;
  settings: RMRSettings;
  paths: StatePaths;
  /** プラグインディレクトリの絶対パス */
  pluginDir: string;
  /** sysrec バイナリの絶対パス（未検出なら ""） */
  resolveBinPath(): string;
  /** Vault ルートの絶対パス（デスクトップは常に取れる） */
  getVaultBasePath(): string | null;
}

export function getVaultBasePath(app: App): string | null {
  const adapter = app.vault.adapter;
  if (adapter instanceof FileSystemAdapter) return adapter.getBasePath();
  return null;
}

export function createContext(
  app: App,
  settings: RMRSettings,
  pluginDir: string
): RecorderContext {
  return {
    app,
    settings,
    paths: makePaths(settings),
    pluginDir,
    resolveBinPath: () => resolveBin({ binPath: settings.binPath, pluginDir }),
    getVaultBasePath: () => getVaultBasePath(app),
  };
}
