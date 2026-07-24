import * as fs from "fs";
import * as path from "path";
import type { RecorderContext } from "../context";
import type { SessionMeta, StartOptions } from "../types";
import { sessionPaths, type SessionFilePaths } from "../state/paths";
import { newSessionId, writeSessionMeta } from "../state/sessionStore";
import { sweepOrphans } from "./sweep";
import { isAlive, pollPidFile, spawnCaffeinate, spawnDetached } from "./spawn";
import { defaultFilename } from "../util/time";
import { ensureDir, exists, safeUnlink, tailFile } from "../util/fsx";
import {
  isSysrecCompatible,
  probeSysrecVersion,
  sysrecIncompatibleMessage,
} from "../util/sysrecVersion";

export interface StartResult {
  sessionId: string;
  out: string;
  pid: number;
  /** 永続化されたセッションメタ（startedAt を含む・watcher/UI はこれを正とする） */
  meta: SessionMeta;
}

/** 起動失敗（ログ tail 付き）。UI は start-error として扱う。 */
export class StartError extends Error {
  logTail?: string;
  constructor(message: string, logTail?: string) {
    super(message);
    this.name = "StartError";
    this.logTail = logTail;
  }
}

/**
 * 録音開始（設計書 §5.2）。順序厳守:
 * sweep → ensureDir → 保存先/ファイル名解決（.m4a 強制・衝突連番）→ status 空 truncate
 * → argv → spawnDetached → pollPidFile → isAlive → 生存 OK のときだけ JSON → caffeinate。
 * 失敗時は pid/status を rm し JSON は書かず、log tail を添えて throw。
 */
export async function startRecording(
  ctx: RecorderContext,
  o: StartOptions
): Promise<StartResult> {
  const bin = ctx.resolveBinPath();
  if (!bin) {
    throw new StartError(
      "sysrec バイナリが見つかりません。設定または診断（doctor）で確認してください。"
    );
  }

  // 0. バイナリの版数照合。古いバイナリは引数を黙って無視して 0 バイトの出力を作り、
  //    停止時に「録音ファイルが生成されませんでした」という原因の分からない形で表面化する。
  //    録音を始める前に、直せる形で止める。
  const ver = probeSysrecVersion(bin);
  if (!isSysrecCompatible(ver)) {
    throw new StartError(sysrecIncompatibleMessage(ver, bin));
  }

  // 1. 孤児掃除（開始前に状態をきれいにする）
  sweepOrphans(ctx);

  // 2. 保存先/ファイル名解決
  ensureDir(o.saveDir);
  const out = resolveOutPath(o.saveDir, o.filename);

  // 3. セッション ID/パス、status を空初期化（sysrec が append する）
  const id = newSessionId();
  const sp = sessionPaths(ctx.paths, id);
  ensureDir(ctx.paths.sessionsDir);
  fs.writeFileSync(sp.status, "");
  // 手動ミキサー: control（プラグイン→sysrec ゲイン）/ level（sysrec→プラグイン RMS）を初期化。
  // sysrec は両ファイルを polling/出力する（メーターは Auto/Manual 両モードで動く）。
  fs.writeFileSync(
    sp.control,
    JSON.stringify({ systemGainDb: o.systemGainDb ?? 0, micGainDb: o.micGainDb ?? 0 })
  );
  fs.writeFileSync(sp.level, JSON.stringify({ system: 0, mic: 0 }));

  // 4. argv
  const argv = buildArgv(ctx, o, out, sp);

  // 5. 起動 → pidfile 待ち → 生存確認
  let spawnedPid: number;
  try {
    spawnedPid = spawnDetached(bin, argv, sp.log);
  } catch (e) {
    cleanupFailed(sp);
    throw new StartError(`起動に失敗しました: ${(e as Error).message}`, tailFile(sp.log, 20));
  }
  void spawnedPid; // pidfile 由来の pid を正とする

  const polled = await pollPidFile(sp.pid, 30, 100);
  if (polled == null || !isAlive(polled)) {
    cleanupFailed(sp);
    throw new StartError(
      "録音プロセスの起動を確認できませんでした（マイク権限やデバイスを確認してください）。",
      tailFile(sp.log, 20)
    );
  }

  // 6. 生存 OK → ここで初めて JSON を書く
  const meta: SessionMeta = {
    id,
    pid: polled,
    platform: "darwin",
    source: o.source,
    agc: o.manualMix ? "off" : o.agc ? "on" : "off",
    manualMix: o.manualMix,
    out,
    bin,
    startedAt: Date.now(),
    label: o.label,
  };
  writeSessionMeta(ctx.paths, meta);

  // 7. スリープ抑止の保険（pid 終了で自動終了）
  spawnCaffeinate(polled);

  return { sessionId: id, out, pid: polled, meta };
}

/**
 * 保存先＋ファイル名から最終 out パスを決める（拡張子強制・衝突連番 2 始まり）。
 * ext 既定は `.m4a`（macOS/sysrec）。Windows Web Audio 経路は mime に応じて `.m4a`/`.webm` を渡す。
 */
export function resolveOutPath(saveDir: string, filename: string, ext = ".m4a"): string {
  let stem = (filename || "").trim().replace(/\.(m4a|mp4|webm)$/i, "");
  if (!stem) stem = defaultFilename();

  let candidate = path.join(saveDir, `${stem}${ext}`);
  let n = 2;
  while (exists(candidate)) {
    candidate = path.join(saveDir, `${stem}-${n}${ext}`);
    n++;
  }
  return candidate;
}

function buildArgv(
  ctx: RecorderContext,
  o: StartOptions,
  out: string,
  sp: SessionFilePaths
): string[] {
  // Manual モードは AGC を使わない（手動ゲインで置き換え）。
  const agc = o.manualMix ? "off" : o.agc ? "on" : "off";
  const argv = [
    "--out", out,
    "--source", o.source,
    "--samplerate", String(o.sampleRate ?? ctx.settings.sampleRate),
    "--channels", String(o.channels ?? ctx.settings.channels),
    "--agc", agc,
    "--status-file", sp.status,
    "--pidfile", sp.pid,
    // メーター/ミキサー用（Auto/Manual 両モードで level は出力される）。
    "--control-file", sp.control,
    "--level-file", sp.level,
    // ノイズゲート閾値（AGC 有効時のみ効く・"off" もしくは dBFS）。マイク／システム音で独立。
    "--mic-gate", ctx.settings.micNoiseGate,
    "--sys-gate", ctx.settings.sysNoiseGate,
  ];
  if (o.manualMix) {
    argv.push(
      "--manual", "on",
      "--system-gain", String(o.systemGainDb ?? 0),
      "--mic-gain", String(o.micGainDb ?? 0)
    );
  }
  if (o.micDevice) argv.push("--mic-device", o.micDevice);
  return argv;
}

/** 起動失敗時: pid/status/control/level を rm（JSON は書いていない・log は tail 用に残す）。 */
function cleanupFailed(sp: SessionFilePaths): void {
  safeUnlink(sp.pid);
  safeUnlink(sp.status);
  safeUnlink(sp.control);
  safeUnlink(sp.level);
}
