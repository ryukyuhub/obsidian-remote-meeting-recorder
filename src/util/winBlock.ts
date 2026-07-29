/**
 * Windows のコード整合性ポリシー（スマート アプリ コントロール / WDAC / セキュリティ製品）による
 * 実行ブロックの判定（Issue #8）。
 *
 * 同梱する whisper.cpp（ggml-org のビルド済み zip）はコード署名が無いため、スマート アプリ
 * コントロールが有効な Windows 11 では**起動そのものを止められる**。ユーザーには OS の警告
 * ポップアップだけが出て、プラグイン側は意味の分からないエラーで文字起こしに失敗していた。
 *
 * 止め方が 2 通りあるので、どちらも拾う必要がある:
 *   1. CreateProcess 自体が失敗する（ERROR_ACCESS_DISABLED_BY_POLICY 1260 等）。
 *      libuv がマップできないコードなので Node からは `UNKNOWN` として見える。
 *   2. プロセス生成は成功を返し、直後にカーネルが終了させる。この場合は**出力を 1 バイトも
 *      出さないまま** STATUS_INVALID_IMAGE_HASH(0xC0000428) 等で終了する。
 */

/** Microsoft の案内ページ（Issue #8 のユーザーが見た警告ポップアップのリンク先）。 */
export const SMART_APP_CONTROL_HELP_URL =
  "https://support.microsoft.com/ja-JP/Windows/Security/Threat-Malware-Protection/smart-app-control-has-blocked-part-of-this-app";

/** ポリシー／セキュリティ製品によるブロックを示す終了コード（値 → ログ用の名前）。 */
const BLOCK_EXIT_CODES = new Map<number, string>([
  [3221226024, "0xC0000428 STATUS_INVALID_IMAGE_HASH"], // 署名検証で拒否
  [3221225506, "0xC0000022 STATUS_ACCESS_DENIED"],
  [1260, "1260 ERROR_ACCESS_DISABLED_BY_POLICY"],
  [225, "225 ERROR_VIRUS_INFECTED"],
]);

/** 依存 DLL が見つからないときの終了コード（ブロックとは別問題・zip の展開不足）。 */
const DLL_NOT_FOUND_EXIT = 3221225781; // 0xC0000135 STATUS_DLL_NOT_FOUND

/** spawn/exec が「起動できなかった」ときに Node が返すコード（Windows でブロックされた場合を含む）。 */
const BLOCK_SPAWN_CODES = new Set(["UNKNOWN", "EPERM", "EACCES"]);

/** 外部プロセスの起動がポリシーに止められたことを表す。呼び出し側は対処の案内を出す。 */
export class LaunchBlockedError extends Error {
  constructor(
    readonly bin: string,
    /** 判定の根拠（終了コード名や errno）。サポート時の手がかりとして表示する。 */
    readonly reason: string
  ) {
    super(
      `Windows が実行をブロックしました（${reason}）。` +
        "スマート アプリ コントロール等のセキュリティ機能が原因のことがほとんどです。"
    );
    this.name = "LaunchBlockedError";
  }
}

/** 依存 DLL 不足で起動できないことを表す（zip の展開が不完全）。 */
export class MissingDllError extends Error {
  constructor(readonly bin: string) {
    super("必要な DLL が見つからず起動できませんでした（展開が不完全な可能性があります）。");
    this.name = "MissingDllError";
  }
}

/**
 * spawn の error イベント（＝プロセスを生成できなかった）がポリシーブロックか。
 * ファイルの存在は呼び出し前に確認済みである前提（ENOENT は別物として扱う）。
 *
 * EPERM/EACCES は POSIX では「実行権限が無い」で日常的に起きるため、判定は Windows 限定。
 * `platform` 引数は E2E から両 OS の挙動を検証するためのもの（既定は実行中の OS）。
 */
export function isBlockedSpawnError(e: unknown, platform = process.platform): boolean {
  if (platform !== "win32") return false;
  const code = (e as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" && BLOCK_SPAWN_CODES.has(code);
}

/**
 * 終了コードがポリシーブロックを示すか。`producedOutput` が true（＝何か出力した）なら
 * プロセスは実際に走っているので、同じコードでもブロックとは見なさない。
 */
export function isBlockedExit(
  code: number | null,
  producedOutput: boolean,
  platform = process.platform
): boolean {
  if (platform !== "win32" || code == null || producedOutput) return false;
  return BLOCK_EXIT_CODES.has(code);
}

/** 終了コードが「依存 DLL 不足」か。 */
export function isMissingDllExit(code: number | null, platform = process.platform): boolean {
  return platform === "win32" && code === DLL_NOT_FOUND_EXIT;
}

/** 終了コードの説明（既知なら名前、未知なら 10 進と 16 進）。 */
export function describeExitCode(code: number | null): string {
  if (code == null) return "終了コード不明";
  const known = BLOCK_EXIT_CODES.get(code);
  if (known) return known;
  if (code === DLL_NOT_FOUND_EXIT) return "0xC0000135 STATUS_DLL_NOT_FOUND";
  return code > 0xffff ? `exit ${code}（0x${code.toString(16).toUpperCase()}）` : `exit ${code}`;
}
