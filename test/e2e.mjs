// ニセバイナリ E2E（設計書 §11-A）。実録音なしで状態機械を駆動し堅牢性を検証する。
// 実行: node test/e2e.mjs  （esbuild で src/ の状態機械をバンドルして読み込む）
import { build } from "esbuild";
import { pathToFileURL } from "url";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const fakeBin = path.join(repoRoot, "test", "fake-sysrec.sh");
fs.chmodSync(fakeBin, 0o755);

// --- 状態機械 API を obsidian 非依存でバンドル ---
const entry = `
export { startRecording, StartError } from "./src/recorder/start";
export { stopRecording, finalizeSession } from "./src/recorder/stop";
export { remix } from "./src/recorder/mix";
export { sweepOrphans } from "./src/recorder/sweep";
export { newSessionId, writeSessionMeta, readSessionMeta, listSessions } from "./src/state/sessionStore";
export { makePaths, sessionPaths } from "./src/state/paths";
export { intermediatePaths, existsWithSize } from "./src/util/fsx";
export { isAlive } from "./src/recorder/spawn";
export { SessionWatcher } from "./src/recorder/watch";
export { restoreInProgressSessions } from "./src/recorder/restore";
`;
const result = await build({
  stdin: { contents: entry, resolveDir: repoRoot, sourcefile: "e2e-entry.ts", loader: "ts" },
  bundle: true,
  format: "esm",
  platform: "node",
  external: ["obsidian"],
  write: false,
});
const bundlePath = path.join(os.tmpdir(), `rmr-e2e-api-${process.pid}.mjs`);
fs.writeFileSync(bundlePath, result.outputFiles[0].text);
const api = await import(pathToFileURL(bundlePath).href);

// --- テストユーティリティ ---
let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) {
    pass++;
    console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
  } else {
    fail++;
    console.log(`  \x1b[31m✗ ${msg}\x1b[0m`);
  }
}
function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}
function makeCtx(tag) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `rmr-e2e-${tag}-`));
  const stateDir = path.join(root, "state");
  const recDir = path.join(root, "rec");
  fs.mkdirSync(recDir, { recursive: true });
  const settings = {
    binPath: fakeBin,
    stateDir,
    sampleRate: 48000,
    channels: 2,
    defaultSource: "both",
  };
  const paths = api.makePaths(settings);
  const ctx = {
    app: null,
    settings,
    paths,
    pluginDir: repoRoot,
    resolveBinPath: () => fakeBin,
    getVaultBasePath: () => null,
  };
  return { ctx, root, recDir, paths };
}
const startOpts = (recDir, source, filename) => ({
  source,
  saveDir: recDir,
  filename,
  agc: true,
});

// ====================================================================
async function testSingle() {
  console.log("\n[1] 単一ソース（system）: start → stop → stopped");
  const { ctx, recDir, paths } = makeCtx("single");
  const { sessionId, out } = await api.startRecording(ctx, startOpts(recDir, "system", "single1"));
  ok(exists(api.sessionPaths(paths, sessionId).json), "起動後にセッション JSON が存在");
  ok(exists(api.sessionPaths(paths, sessionId).pid), "pidfile が存在");
  const ev = await api.stopRecording(ctx, sessionId);
  ok(ev.event === "stopped", `event=stopped（実際: ${ev.event}）`);
  ok(ev.path === out && exists(out), "最終 .m4a が出力パスに存在");
  ok(ev.bytes > 0, "bytes > 0");
  ok(!exists(api.sessionPaths(paths, sessionId).json), "停止後にセッション JSON が消える");
}

async function testBothMixOk() {
  console.log("\n[2] both（mix 成功）: 中間2ファイル → mix → 中間削除");
  const { ctx, recDir, paths } = makeCtx("both-ok");
  delete process.env.FAKE_MIX_FAIL;
  const { sessionId, out } = await api.startRecording(ctx, startOpts(recDir, "both", "both1"));
  const inter = api.intermediatePaths(out);
  const ev = await api.stopRecording(ctx, sessionId);
  ok(ev.event === "stopped", `event=stopped（実際: ${ev.event}）`);
  ok(exists(out), "最終 .m4a が存在");
  ok(!exists(inter.sys) && !exists(inter.mic), "中間ファイルが削除されている");
  ok(!exists(api.sessionPaths(paths, sessionId).json), "セッション JSON が消える");
}

async function testMixFailThenRemix() {
  console.log("\n[3] both（mix 失敗）→ stop-warning 温存 → remix 復旧");
  const { ctx, recDir, paths } = makeCtx("mixfail");
  const { sessionId, out } = await api.startRecording(ctx, startOpts(recDir, "both", "both2"));
  const inter = api.intermediatePaths(out);

  process.env.FAKE_MIX_FAIL = "1";
  const ev = await api.stopRecording(ctx, sessionId);
  ok(ev.event === "stop-warning", `event=stop-warning（実際: ${ev.event}）`);
  ok(exists(inter.sys) && exists(inter.mic), "中間ファイルが温存されている");
  ok(exists(api.sessionPaths(paths, sessionId).json), "セッション JSON が温存されている");
  ok(!exists(api.sessionPaths(paths, sessionId).pid), "pidfile は削除されている");
  ok(!exists(out), "最終ファイルはまだ無い");

  delete process.env.FAKE_MIX_FAIL;
  const rev = await api.remix(ctx, { sessionId });
  ok(rev.event === "remixed", `remix event=remixed（実際: ${rev.event}）`);
  ok(exists(out), "remix で最終 .m4a が生成");
  ok(!exists(inter.sys) && !exists(inter.mic), "remix 後に中間ファイル削除");
  ok(!exists(api.sessionPaths(paths, sessionId).json), "remix 後にセッション JSON が消える");
}

async function testRescueRename() {
  console.log("\n[4] both だが片方だけ → rescue-rename で救済");
  const { ctx, recDir, paths } = makeCtx("rescue");
  const id = api.newSessionId();
  const out = path.join(recDir, "rescue1.m4a");
  const inter = api.intermediatePaths(out);
  fs.writeFileSync(inter.sys, "only-sys-recorded"); // mic は無い
  const meta = {
    id,
    pid: 999999, // 死亡 pid
    platform: "darwin",
    source: "both",
    agc: "on",
    out,
    bin: fakeBin,
    startedAt: Date.now(),
  };
  api.writeSessionMeta(paths, meta);
  const ev = await api.finalizeSession(ctx, meta);
  ok(ev.event === "stopped", `event=stopped（実際: ${ev.event}）`);
  ok(exists(out), "sys を rename して最終 .m4a 化");
  ok(!exists(inter.sys), "元の中間ファイルは rename で消費");
  ok(!exists(api.sessionPaths(paths, id).json), "セッション JSON が消える");
}

async function testSweep() {
  console.log("\n[5] sweepOrphans: 中間ありは温存 / 中間なしは削除");
  const { ctx, recDir, paths } = makeCtx("sweep");

  // (a) 死亡 both + 中間あり → 温存
  const idA = api.newSessionId();
  const outA = path.join(recDir, "sweepA.m4a");
  const interA = api.intermediatePaths(outA);
  fs.writeFileSync(interA.sys, "s");
  fs.writeFileSync(interA.mic, "m");
  api.writeSessionMeta(paths, {
    id: idA, pid: 999999, platform: "darwin", source: "both", agc: "on",
    out: outA, bin: fakeBin, startedAt: Date.now(),
  });

  // (b) 死亡 system + 中間なし → 削除
  const idB = api.newSessionId();
  api.writeSessionMeta(paths, {
    id: idB, pid: 999998, platform: "darwin", source: "system", agc: "on",
    out: path.join(recDir, "sweepB.m4a"), bin: fakeBin, startedAt: Date.now(),
  });

  api.sweepOrphans(ctx);
  ok(exists(api.sessionPaths(paths, idA).json), "中間あり死亡セッションは温存（remix 待ち）");
  ok(!exists(api.sessionPaths(paths, idB).json), "中間なし死亡セッションは削除");
}

async function testStartError() {
  console.log("\n[6] 起動失敗（pidfile 無し）→ StartError");
  const { ctx, recDir, paths } = makeCtx("starterr");
  process.env.FAKE_NO_PIDFILE = "1";
  let threw = false;
  let sessionCountBefore = api.listSessions(paths).length;
  try {
    await api.startRecording(ctx, startOpts(recDir, "system", "err1"));
  } catch (e) {
    threw = true;
    ok(e.name === "StartError", `StartError が投げられる（実際: ${e.name}）`);
  }
  delete process.env.FAKE_NO_PIDFILE;
  ok(threw, "起動失敗で throw する");
  ok(api.listSessions(paths).length === sessionCountBefore, "失敗時にセッション JSON を残さない");
}

async function testRestoreClassify() {
  console.log("\n[7] restoreInProgressSessions: 生存=active / 死亡+中間=needsRemix");
  const { ctx, recDir, paths } = makeCtx("restore");
  delete process.env.FAKE_MIX_FAIL;

  // 生存セッション（実プロセス）
  const live = await api.startRecording(ctx, startOpts(recDir, "system", "live1"));

  // 死亡 both + 中間あり
  const deadId = api.newSessionId();
  const deadOut = path.join(recDir, "dead1.m4a");
  const inter = api.intermediatePaths(deadOut);
  fs.writeFileSync(inter.sys, "s");
  fs.writeFileSync(inter.mic, "m");
  api.writeSessionMeta(paths, {
    id: deadId, pid: 999999, platform: "darwin", source: "both", agc: "on",
    out: deadOut, bin: fakeBin, startedAt: Date.now(),
  });

  const r = api.restoreInProgressSessions(ctx);
  ok(r.active.some((m) => m.id === live.sessionId), "生存セッションが active に分類");
  ok(r.needsRemix.some((m) => m.id === deadId), "死亡+中間が needsRemix に分類");

  await api.stopRecording(ctx, live.sessionId); // 後始末
}

async function testWatcherExternalStop() {
  console.log("\n[8] SessionWatcher: 外部停止（蓋閉じ/クラッシュ相当）→ 自動 finalize");
  const { ctx, recDir } = makeCtx("watcher");
  delete process.env.FAKE_MIX_FAIL;
  const started = await api.startRecording(ctx, startOpts(recDir, "system", "watch1"));

  const terminal = await new Promise((resolve) => {
    const w = new api.SessionWatcher(
      ctx,
      started.meta,
      () => {},
      (ev) => resolve(ev)
    );
    w.start();
    // 外部から SIGTERM（sysrec 相当の fake が finalize してデータを残す）
    setTimeout(() => {
      try { process.kill(started.meta.pid, "SIGTERM"); } catch {}
    }, 300);
  });

  ok(terminal.event === "stopped", `watcher が stopped を検出（実際: ${terminal.event}）`);
  ok(exists(started.out), "外部停止でも録音ファイルが残る");
  ok(!exists(api.sessionPaths(ctx.paths, started.sessionId).json), "finalize でセッションが片付く");
}

// ====================================================================
try {
  await testSingle();
  await testBothMixOk();
  await testMixFailThenRemix();
  await testRescueRename();
  await testSweep();
  await testStartError();
  await testRestoreClassify();
  await testWatcherExternalStop();
} catch (e) {
  console.error("\n予期しないエラー:", e);
  fail++;
} finally {
  try { fs.unlinkSync(bundlePath); } catch {}
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
