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

/** 非互換時にユーザーへ出す文言（doctor / 録音開始で共通）。 */
export function sysrecIncompatibleMessage(v: SysrecVersion | null, binPath: string): string {
  const found = v ? `検出したバイナリは abi ${v.abi}（v${v.version}）` : "検出したバイナリは版数を申告しません（0.5.x 以前）";
  return (
    `sysrec がプラグインより古いため録音できません。${found}、必要なのは abi ${REQUIRED_SYSREC_ABI} 以上です。\n` +
    `診断（doctor）の「sysrec を取得」で最新版に入れ替えてください。\n対象: ${binPath}`
  );
}
