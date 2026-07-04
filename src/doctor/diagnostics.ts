import { execFile, execFileSync } from "child_process";
import { promisify } from "util";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import type { RecorderContext } from "../context";
import { binCandidates } from "../util/resolveBin";

const execFileAsync = promisify(execFile);

export type DoctorStatus = "ok" | "ng" | "warn" | "info";

export interface DoctorFix {
  label: string;
  /** 実行して結果メッセージを返す。 */
  run: () => Promise<string>;
}

export interface DoctorCheck {
  id: string;
  label: string;
  status: DoctorStatus;
  detail: string;
  fix?: DoctorFix;
}

/** 短命な外部コマンドを同期実行（例外は握って結果化）。 */
function tryExecSync(
  cmd: string,
  args: string[]
): { ok: boolean; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(cmd, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5000,
    });
    return { ok: true, stdout: stdout.toString(), stderr: "" };
  } catch (e: unknown) {
    const err = e as { stdout?: Buffer | string; stderr?: Buffer | string };
    return {
      ok: false,
      stdout: err.stdout ? err.stdout.toString() : "",
      stderr: err.stderr ? err.stderr.toString() : "",
    };
  }
}

/**
 * macOS のプロダクトバージョンを取得。
 * 注意: Darwin カーネル番号は macOS 15→26 の年号改称でメジャーと線形対応しない
 * （Darwin 24=macOS 15, Darwin 25=macOS 26）。そのため sw_vers を真実の源にする。
 */
function macOSVersion(): { major: number; product: string } | null {
  if (process.platform !== "darwin") return null;
  const r = tryExecSync("sw_vers", ["-productVersion"]);
  if (!r.ok) return null;
  const product = r.stdout.trim();
  const major = parseInt(product.split(".")[0] ?? "0", 10);
  if (!Number.isFinite(major) || major <= 0) return null;
  return { major, product };
}

/** 状態ディレクトリの書き込み可否を実書き込みで確認。 */
function checkStateDirWritable(dir: string): { ok: boolean; detail: string } {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.rmr-probe-${process.pid}`);
    fs.writeFileSync(probe, "ok");
    fs.unlinkSync(probe);
    return { ok: true, detail: `書き込み可: ${dir}` };
  } catch (e) {
    return { ok: false, detail: `書き込み不可: ${dir}（${(e as Error).message}）` };
  }
}

/**
 * セットアップ診断を実行（設計書 §9.4）。
 * バイナリ有無 / 実行可否 / 署名 / arch / quarantine / 状態ディレクトリ / macOS / TCC 案内。
 */
export function runDoctor(ctx: RecorderContext): DoctorCheck[] {
  const checks: DoctorCheck[] = [];

  // 1. macOS バージョン
  const ver = macOSVersion();
  checks.push({
    id: "macos",
    label: "macOS 15 以上",
    status: process.platform !== "darwin" ? "ng" : ver && ver.major >= 15 ? "ok" : "ng",
    detail:
      process.platform !== "darwin"
        ? `このプラグインは macOS 専用です（現在: ${process.platform}）`
        : ver
          ? `macOS ${ver.product}（Darwin ${os.release()}）`
          : "バージョンを判定できませんでした",
  });

  // 2. バイナリ検出
  const candidates = binCandidates({
    binPath: ctx.settings.binPath,
    pluginDir: ctx.pluginDir,
  });
  const found = candidates.find((c) => c.exists);
  const binPath = found?.path ?? "";
  const swiftBuildDir = path.join(ctx.pluginDir, "native", "sysrec");
  const buildScript = path.join(swiftBuildDir, "build.sh");

  const buildFix: DoctorFix = {
    label: "sysrec をビルド",
    run: async () => {
      const { stderr } = await execFileAsync(
        "sh",
        [buildScript, path.join(swiftBuildDir, "sysrec")],
        { timeout: 120000 }
      );
      return stderr?.trim() || "ビルド完了。診断を再実行してください。";
    },
  };

  if (!found) {
    checks.push({
      id: "binary",
      label: "sysrec バイナリ",
      status: "ng",
      detail:
        "見つかりません。native/sysrec/sysrec をビルドするか、設定でパスを指定してください。\n" +
        `探索: ${candidates.map((c) => `${c.origin}=${c.path}`).join(" / ")}`,
      fix: fs.existsSync(buildScript) ? buildFix : undefined,
    });
    // バイナリが無いと以降の署名/arch/quarantine は不能
    checks.push(...stateAndTccChecks(ctx));
    return checks;
  }

  checks.push({
    id: "binary",
    label: "sysrec バイナリ",
    status: "ok",
    detail: `検出: ${binPath}（${found.origin}）`,
  });

  // 3. 実行可否（X_OK）
  checks.push({
    id: "executable",
    label: "実行権限（X_OK）",
    status: found.executable ? "ok" : "ng",
    detail: found.executable ? "実行可能" : "実行権限がありません（chmod +x が必要）",
  });

  // 4. 署名（codesign -dv）
  const cs = tryExecSync("codesign", ["-dv", binPath]);
  const csText = (cs.stderr || cs.stdout).trim();
  checks.push({
    id: "codesign",
    label: "コード署名",
    status: cs.ok ? "ok" : "warn",
    detail: cs.ok
      ? csText.split("\n")[0] || "署名あり"
      : "署名が確認できません。TCC 権限が不安定になる場合は build.sh の ad-hoc 署名を実行してください。",
  });

  // 5. アーキテクチャ（lipo -archs）
  const arch = tryExecSync("lipo", ["-archs", binPath]);
  const archText = arch.stdout.trim() || arch.stderr.trim();
  const hasArm = /arm64/.test(archText);
  checks.push({
    id: "arch",
    label: "アーキテクチャ",
    status: arch.ok ? (hasArm ? "ok" : "warn") : "warn",
    detail: arch.ok
      ? `${archText}${hasArm ? "" : "（arm64 を含みません）"}`
      : "アーキテクチャを判定できませんでした",
  });

  // 6. quarantine 属性
  const quar = tryExecSync("xattr", ["-p", "com.apple.quarantine", binPath]);
  checks.push({
    id: "quarantine",
    label: "quarantine 属性",
    status: quar.ok ? "warn" : "ok",
    detail: quar.ok
      ? "quarantine 属性が付いています（実行がブロックされる場合があります）"
      : "なし",
    fix: quar.ok
      ? {
          label: "quarantine を除去",
          run: async () => {
            await execFileAsync("xattr", ["-d", "com.apple.quarantine", binPath]);
            return "quarantine を除去しました。";
          },
        }
      : undefined,
  });

  // 7. 状態ディレクトリ / 8. TCC
  checks.push(...stateAndTccChecks(ctx));

  return checks;
}

function stateAndTccChecks(ctx: RecorderContext): DoctorCheck[] {
  const out: DoctorCheck[] = [];

  const sw = checkStateDirWritable(ctx.paths.stateDir);
  out.push({
    id: "statedir",
    label: "状態ディレクトリの書き込み",
    status: sw.ok ? "ok" : "ng",
    detail: sw.detail,
  });

  out.push({
    id: "tcc",
    label: "画面収録権限（TCC）",
    status: "info",
    detail:
      "初回録音時に Obsidian への許可ダイアログが出ます。\n" +
      "「システム設定 > プライバシーとセキュリティ > 画面収録」で Obsidian を許可してください。\n" +
      "（--source mic でも内部で ScreenCaptureKit を開くため画面収録権限が必要です）",
  });

  return out;
}
