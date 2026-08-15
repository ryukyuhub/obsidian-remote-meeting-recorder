import { execFileSync } from "child_process";

/**
 * プラグインが必要とする sysrec の CLI 契約バージョン（sysrec.swift の `sysrecAbi` と対）。
 * バイナリはプラグイン本体（main.js）と別配布なので、更新が片方だけ進む事故が起きる。
 * 実際に「main.js だけ 0.6.0 に更新、バイナリは 0.2 系のまま」で録音が 0 バイトになり、
 * doctor も「検出: …」と ok を出していた。数値で照合して先に止める。
 */
export const REQUIRED_SYSREC_ABI = 2;

export interface SysrecVersion {
  version: string;
  abi: number;
}

/**
 * `sysrec --version` を叩いて版数を得る。古いバイナリは `--version` を知らず
 * 非ゼロ終了するので、その場合は null（＝古い/非互換）を返す。
 */
export function probeSysrecVersion(bin: string): SysrecVersion | null {
  if (!bin) return null;
  try {
    const out = execFileSync(bin, ["--version"], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const obj = JSON.parse(out.trim()) as { version?: unknown; abi?: unknown };
    if (typeof obj.abi !== "number") return null;
    return { abi: obj.abi, version: typeof obj.version === "string" ? obj.version : "?" };
  } catch {
    // --version 非対応（古い）／実行不可／タイムアウト
    return null;
  }
}

/** 現在のプラグインで使える版か。 */
export function isSysrecCompatible(v: SysrecVersion | null): v is SysrecVersion {
  return !!v && v.abi >= REQUIRED_SYSREC_ABI;
}

/** `0.11.6` のような版数を [major, minor, patch] にする（読めなければ null）。 */
function parseVersion(v: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/**
 * **バイナリがプラグイン本体より古いか。**
 *
 * abi が同じでも版数がズレていることはある。録音エンジンの修正は sysrec.swift 側だけに
 * 入ることがあり（例: 0.11.6 の BT 44.1kHz プツプツ修正は Swift のみ）、その場合 BRAT で
 * main.js を更新してもユーザの録音は直らない。abi 照合は「0 バイト録音」級の非互換しか
 * 止めないので素通りし、doctor も ok を出してしまう。版数でも見て気付けるようにする。
 *
 * `build.sh` が manifest.json から版数を刻むので、正しく揃っていれば両者は同じ文字列になる。
 * 読めない版数（自前ビルド等）は比較せず false（＝警告しない）。
 */
export function isSysrecOutdated(binVersion: string, pluginVersion: string): boolean {
  const bin = parseVersion(binVersion);
  const plugin = parseVersion(pluginVersion);
  if (!bin || !plugin) return false;
  for (let i = 0; i < 3; i++) {
    if (bin[i] !== plugin[i]) return bin[i] < plugin[i];
  }
  return false;
}

/** 版ズレ時にユーザーへ出す文言（録音はできるので警告どまり）。 */
export function sysrecOutdatedMessage(
  binVersion: string,
  pluginVersion: string,
  binPath: string
): string {
  return (
    `バイナリが古いままです。プラグイン本体は v${pluginVersion}、sysrec は v${binVersion} です。\n` +
    `録音エンジンの修正は sysrec 側だけに入ることがあり（例: BT 出力 44.1kHz でのプツプツ）、` +
    `本体を更新してもバイナリが古いと直りません。録音自体はできます。\n` +
    `「sysrec を取得」で入れ替えてください。\n対象: ${binPath}`
  );
}

/** 非互換時にユーザーへ出す文言（doctor / 録音開始で共通）。 */
export function sysrecIncompatibleMessage(v: SysrecVersion | null, binPath: string): string {
  const found = v ? `検出したバイナリは abi ${v.abi}（v${v.version}）` : "検出したバイナリは版数を申告しません（0.5.x 以前）";
  return (
    `sysrec がプラグインより古いため録音できません。${found}、必要なのは abi ${REQUIRED_SYSREC_ABI} 以上です。\n` +
    `診断（doctor）の「sysrec を取得」で最新版に入れ替えてください。\n対象: ${binPath}`
  );
}
