import { getElectronRemote } from "./electron";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * グローバルホットキー（設計書 §9.4・§14.3）。
 * Electron globalShortcut で Obsidian 非フォーカスでも start/stop を効かせる。
 * 会議アプリを前面にしたまま操作できる。remote が取れない環境では available()=false。
 */
export class GlobalHotkeys {
  private gs: any = null;
  private registered: string[] = [];

  private shortcut(): any {
    const remote = getElectronRemote();
    return (remote as any)?.globalShortcut ?? null;
  }

  available(): boolean {
    return this.shortcut() != null;
  }

  /** accelerator（例 "CommandOrControl+Shift+R"）にハンドラを登録。成功で true。 */
  register(accelerator: string, handler: () => void): boolean {
    const gs = this.shortcut();
    if (!gs || !accelerator) return false;
    this.gs = gs;
    try {
      if (gs.isRegistered(accelerator)) gs.unregister(accelerator);
      const ok: boolean = gs.register(accelerator, handler);
      if (ok) this.registered.push(accelerator);
      return ok;
    } catch {
      return false;
    }
  }

  /** 登録済みショートカットを全解除（unload 時に必須）。 */
  unregisterAll(): void {
    const gs = this.gs ?? this.shortcut();
    if (!gs) return;
    for (const a of this.registered) {
      try {
        gs.unregister(a);
      } catch {
        /* noop */
      }
    }
    this.registered = [];
  }
}
