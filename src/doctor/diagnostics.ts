import { execFileSync } from "child_process";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import type { RecorderContext } from "../context";
import { binCandidates } from "../util/resolveBin";
import { getElectronRemote } from "../platform/electron";
import { pickAudioFormat } from "../recorder/webCapture";
import { execFileAsync } from "../util/exec";
import {
  resolveWhisperBin,
  resolveWhisperModel,
  whisperDir,
  whisperModelsDir,
  modelDownloadTarget,
} from "../transcribe/resolveWhisper";

// 外部コマンドのタイムアウト（ms）
const PROBE_TIMEOUT_MS = 5000; // codesign/lipo/xattr/list-devices 等の短命プローブ
const BUILD_TIMEOUT_MS = 120_000; // sysrec のビルド
const DOWNLOAD_TIMEOUT_MS = 300_000; // sysrec バイナリのダウンロード
const MODEL_DOWNLOAD_TIMEOUT_MS = 1_800_000; // Whisper モデル（数百MB〜）

// sysrec check-permission の終了コード
const TCC_OK = 0; // 許可済み
const TCC_DENIED = 2; // 明示的に拒否

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

/** 外部コマンドの終了コードだけ取る（0=成功 / N=失敗 / null=起動不可）。 */
function execStatus(cmd: string, args: string[]): number | null {
  try {
    execFileSync(cmd, args, { stdio: "ignore", timeout: PROBE_TIMEOUT_MS });
    return 0;
  } catch (e) {
    const err = e as { status?: number };
    return typeof err.status === "number" ? err.status : null;
  }
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
      timeout: PROBE_TIMEOUT_MS,
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
  // Windows は録音経路（Web Audio / ループバック）が macOS と別なので専用の診断に分岐する。
  if (process.platform === "win32") return windowsDoctor(ctx);

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

  const sysrecTarget = path.join(swiftBuildDir, "sysrec");

  const buildFix: DoctorFix = {
    label: "sysrec をビルド",
    run: async () => {
      const { stderr } = await execFileAsync("sh", [buildScript, sysrecTarget], {
        timeout: BUILD_TIMEOUT_MS,
      });
      return stderr?.trim() || "ビルド完了。診断を再実行してください。";
    },
  };

  // BRAT/自己配布向け: GitHub リリースの ad-hoc バイナリを取得して配置する。
  // Xcode 不要。curl 取得なので隔離属性は付きにくいが、念のため xattr -c で除去。
  const downloadFix: DoctorFix = {
    label: "sysrec を取得",
    run: async () => {
      const url =
        "https://github.com/ryukyuhub/obsidian-remote-meeting-recorder/releases/latest/download/sysrec";
      fs.mkdirSync(swiftBuildDir, { recursive: true });
      await execFileAsync("curl", ["-L", "--fail", "-o", sysrecTarget, url], {
        timeout: DOWNLOAD_TIMEOUT_MS,
      });
      fs.chmodSync(sysrecTarget, 0o755);
      try {
        await execFileAsync("xattr", ["-c", sysrecTarget]);
      } catch {
        // 隔離属性が無い等は無視
      }
      return `取得完了: ${sysrecTarget}\n診断を再実行してください。`;
    },
  };

  if (!found) {
    checks.push({
      id: "binary",
      label: "sysrec バイナリ",
      status: "ng",
      detail:
        "見つかりません。「sysrec を取得」でリリースからダウンロードするか、" +
        "ソースがあれば npm run build-sysrec でビルドしてください。\n" +
        `探索: ${candidates.map((c) => `${c.origin}=${c.path}`).join(" / ")}`,
      // ソース（build.sh）があればビルド、無ければ（BRAT 等）ダウンロードを提示。
      fix: fs.existsSync(buildScript) ? buildFix : downloadFix,
    });
    // バイナリが無いと以降の署名/arch/quarantine/権限は不能
    checks.push(...stateAndTccChecks(ctx, null));
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

  // 6.5 入力（マイク）デバイス一覧
  const dev = tryExecSync(binPath, ["list-devices"]);
  let deviceStatus: DoctorStatus = "warn";
  let deviceDetail = "一覧を取得できませんでした（古いバイナリの可能性）";
  if (dev.ok) {
    try {
      const arr = JSON.parse(dev.stdout) as Array<{ name?: string }>;
      if (Array.isArray(arr)) {
        deviceStatus = arr.length > 0 ? "ok" : "warn";
        deviceDetail =
          arr.length > 0
            ? arr.map((d) => d.name ?? "?").join(" / ")
            : "マイクが見つかりません";
      }
    } catch {
      // JSON でない = 古いバイナリ
    }
  }
  checks.push({ id: "devices", label: "入力デバイス", status: deviceStatus, detail: deviceDetail });

  // 7. 状態ディレクトリ / 8. TCC（実バイナリで権限プリフライト）
  checks.push(...stateAndTccChecks(ctx, binPath));

  // 9. 文字起こし（backend 別・Phase 6）
  checks.push(...transcribeChecks(ctx));

  return checks;
}

/**
 * Windows 用の診断（Windows対応 実装計画 §Phase W3）。
 * macOS 固有（sysrec/codesign/lipo/xattr/TCC）は該当しないため、ループバック可否・
 * 録音フォーマット・マイク許可案内・状態ディレクトリ・文字起こしのみを見る。
 */
function windowsDoctor(ctx: RecorderContext): DoctorCheck[] {
  const checks: DoctorCheck[] = [];

  // 1. 対応 OS
  checks.push({
    id: "os",
    label: "対応 OS",
    status: "ok",
    detail: `Windows（${os.release()}）。システム音声はループバックで取得します（外部バイナリ不要）。`,
  });

  // 2. システム音声（ループバック）= Electron メイン session へのアクセス可否
  const remote = getElectronRemote() as unknown as {
    getCurrentWebContents?: () => { session?: { setDisplayMediaRequestHandler?: unknown } };
    session?: { defaultSession?: { setDisplayMediaRequestHandler?: unknown } };
  } | null;
  const session = remote?.getCurrentWebContents?.().session ?? remote?.session?.defaultSession;
  const canLoopback = !!session && typeof session.setDisplayMediaRequestHandler === "function";
  checks.push({
    id: "loopback",
    label: "システム音声（ループバック）",
    status: canLoopback ? "ok" : "ng",
    detail: canLoopback
      ? "メインプロセスの session にアクセスできます（会議相手の声を録音できます）。"
      : "Electron のメイン session にアクセスできませんでした。システム音声を録音できない可能性があります。",
  });

  // 3. 録音フォーマット（mp4/AAC 優先 → webm）
  const fmt = pickAudioFormat();
  checks.push({
    id: "format",
    label: "録音フォーマット",
    status: fmt.mimeType ? "ok" : "warn",
    detail: fmt.mimeType
      ? `${fmt.mimeType}（${fmt.ext}）で録音します。`
      : "対応フォーマットを判定できませんでした（webm で試行します）。",
  });

  // 4. マイク許可（Windows 設定の案内）
  checks.push({
    id: "mic-privacy",
    label: "マイクの許可",
    status: "info",
    detail:
      "マイクが録音できない場合は「Windows 設定 > プライバシーとセキュリティ > マイク」で" +
      "「マイクへのアクセス」と「デスクトップ アプリにマイクへのアクセスを許可する」をオンにしてください。",
  });

  // 5. 状態ディレクトリの書き込み
  const sw = checkStateDirWritable(ctx.paths.stateDir);
  checks.push({
    id: "statedir",
    label: "状態ディレクトリの書き込み",
    status: sw.ok ? "ok" : "ng",
    detail: sw.detail,
  });

  // 6. 文字起こし（whisper.cpp・録音とは独立）
  checks.push(...transcribeChecks(ctx));

  return checks;
}

/** 文字起こし（同梱 whisper.cpp）のバイナリ/モデルをチェック。 */
function transcribeChecks(ctx: RecorderContext): DoctorCheck[] {
  const s = ctx.settings;
  const out: DoctorCheck[] = [];
  const bin = resolveWhisperBin(ctx.pluginDir, s.whisperCppBinPath);
  const isWin = process.platform === "win32";

  // Windows: ggml-org/whisper.cpp の CPU 版 zip を native/whisper/ に取得＋展開する。
  // 展開後は Release/whisper-cli.exe（同階層に必要 DLL 群）。Xcode/署名不要。
  const winWhisperFix: DoctorFix = {
    label: "Windows 版 whisper を取得",
    run: async () => {
      const dir = whisperDir(ctx.pluginDir);
      fs.mkdirSync(dir, { recursive: true });
      const zip = path.join(dir, "whisper-bin-x64.zip");
      const url =
        "https://github.com/ggml-org/whisper.cpp/releases/latest/download/whisper-bin-x64.zip";
      await execFileAsync("curl", ["-L", "--fail", "-o", zip, url], { timeout: 600000 });
      // Windows 10+ 同梱の tar.exe は zip を展開できる。
      await execFileAsync("tar", ["-xf", zip, "-C", dir], { timeout: 120000 });
      try {
        fs.unlinkSync(zip);
      } catch {
        // 展開済みなので zip 削除失敗は無視
      }
      return "取得・展開しました（native/whisper/Release/whisper-cli.exe）。診断を再実行してください。";
    },
  };

  out.push({
    id: "whispercpp-bin",
    label: "whisper.cpp バイナリ",
    status: bin ? "ok" : "warn",
    detail: bin
      ? bin
      : isWin
        ? "見つかりません。文字起こしを使う場合は「Windows 版 whisper を取得」で whisper.cpp（CPU 版）を取得できます。"
        : "見つかりません。`npm run build-whisper` でビルドするか `brew install whisper-cpp` してください。",
    fix: bin ? undefined : isWin ? winWhisperFix : undefined,
  });

  const model = resolveWhisperModel(ctx.pluginDir, s.whisperCppModel);
  const dlName = (s.whisperCppModel || "large-v3-turbo-q5_0").trim();
  out.push({
    id: "whispercpp-model",
    label: "Whisper モデル",
    status: model ? "ok" : "warn",
    detail: model ? model : `見つかりません（${dlName} をダウンロードできます・数百MB〜）。`,
    fix: model
      ? undefined
      : {
          label: `${dlName} を取得`,
          run: async () => {
            const target = modelDownloadTarget(ctx.pluginDir, dlName);
            fs.mkdirSync(whisperModelsDir(ctx.pluginDir), { recursive: true });
            const url =
              "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/" +
              path.basename(target);
            await execFileAsync("curl", ["-L", "--fail", "-o", target, url], {
              timeout: MODEL_DOWNLOAD_TIMEOUT_MS,
            });
            return `ダウンロード完了: ${target}`;
          },
        },
  });
  return out;
}

function stateAndTccChecks(ctx: RecorderContext, binPath: string | null): DoctorCheck[] {
  const out: DoctorCheck[] = [];

  const sw = checkStateDirWritable(ctx.paths.stateDir);
  out.push({
    id: "statedir",
    label: "状態ディレクトリの書き込み",
    status: sw.ok ? "ok" : "ng",
    detail: sw.detail,
  });

  out.push(tccCheck(binPath));
  return out;
}

const TCC_GUIDE =
  "「システム設定 > プライバシーとセキュリティ > 画面収録」で Obsidian を許可してください。\n" +
  "（--source mic でも内部で ScreenCaptureKit を開くため画面収録権限が必要です）";

/**
 * 画面収録権限（TCC）を sysrec check-permission で実検査（録音は開始しない）。
 * バイナリが権限を持つ実体（Obsidian から spawn されれば Obsidian の権限）を反映する。
 */
function tccCheck(binPath: string | null): DoctorCheck {
  if (!binPath) {
    return {
      id: "tcc",
      label: "画面収録権限（TCC）",
      status: "info",
      detail: "バイナリ未検出のため権限を検査できません。\n" + TCC_GUIDE,
    };
  }
  const code = execStatus(binPath, ["check-permission"]);
  if (code === TCC_OK) {
    return {
      id: "tcc",
      label: "画面収録権限（TCC）",
      status: "ok",
      detail: "許可されています（システム音声を録音できます）。",
    };
  }
  if (code === TCC_DENIED) {
    return {
      id: "tcc",
      label: "画面収録権限（TCC）",
      status: "ng",
      detail: "許可されていません。初回録音時に許可ダイアログが出ます。\n" + TCC_GUIDE,
    };
  }
  // 古いバイナリ（check-permission 非対応）や判定不能
  return {
    id: "tcc",
    label: "画面収録権限（TCC）",
    status: "info",
    detail: "権限状態を判定できませんでした（初回録音時に許可ダイアログが出ます）。\n" + TCC_GUIDE,
  };
}
