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
export { nextAgcState, initialAgcState, rmsOf, AGC_TARGET_RMS, AGC_GATE_RMS, AGC_MAX_GAIN, AGC_MIN_GAIN } from "./src/recorder/agc";
export { nextNormalizerState, initialNormalizerState, NORM_TARGET_RMS, NORM_GATE_RMS, NORM_MAX_GAIN, NORM_MIN_GAIN, NORM_WARMUP_SEC } from "./src/recorder/agc";
`;
const result = await build({
  stdin: { contents: entry, resolveDir: repoRoot, sourcefile: "e2e-entry.ts", loader: "ts" },
  bundle: true,
  format: "esm",
  platform: "node",
  external: ["obsidian"],
  write: false,
  // 本番コードは Obsidian レンダラ前提で window.setInterval 等を使う。
  // Node で走る E2E では window を globalThis に橋渡しして同等に動かす。
  banner: { js: "globalThis.window ??= globalThis;" },
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
// Issue #4: AutoGain オフ（手動ミキサー含む）は mix も AGC も通らないため、
// single ソースでは停止時に仕上げの正規化を掛ける。失敗しても録音は失わない。
async function testSingleNormalizeWhenAgcOff() {
  console.log("\n[9] single + AutoGain オフ: 停止時に normalize を通す");
  const { ctx, recDir, paths } = makeCtx("norm-off");
  delete process.env.FAKE_NORMALIZE_FAIL;
  const { sessionId, out } = await api.startRecording(ctx, {
    ...startOpts(recDir, "mic", "norm1"),
    agc: false,
  });
  const ev = await api.stopRecording(ctx, sessionId);
  ok(ev.event === "stopped", `event=stopped（実際: ${ev.event}）`);
  ok(exists(out), "最終 .m4a が存在");
  ok(
    fs.readFileSync(out, "utf8").includes("fake-normalized"),
    "AutoGain オフの single は normalize 済みファイルに差し替わる"
  );
  ok(!exists(`${out}.norm.m4a`), "normalize の一時ファイルが残らない");
  ok(!exists(api.sessionPaths(paths, sessionId).json), "停止後にセッション JSON が消える");
}

// 録音時 AGC はゲート（-42 dBFS）未満に反応しないので「AGC オン＝補正済み」は成り立たない。
// 実測で AutoGain オンの system 単独がオフより 18 dB 小さくなっていたため、AutoGain の
// 有無に関わらず normalize を通す（無駄な再エンコードは sysrec 側の exit 3 で防ぐ）。
async function testSingleNormalizeWhenAgcOn() {
  console.log("\n[10] single + AutoGain オン: normalize を通す（AGC はゲート未満に効かないため）");
  const { ctx, recDir } = makeCtx("norm-on");
  delete process.env.FAKE_NORMALIZE_FAIL;
  const { sessionId, out } = await api.startRecording(ctx, startOpts(recDir, "mic", "norm2"));
  const ev = await api.stopRecording(ctx, sessionId);
  ok(ev.event === "stopped", `event=stopped（実際: ${ev.event}）`);
  ok(
    fs.readFileSync(out, "utf8").includes("fake-normalized"),
    "AutoGain オンでも single は normalize 済みファイルに差し替わる"
  );
  ok(!exists(`${out}.norm.m4a`), "normalize の一時ファイルが残らない");
}

// 既に目標レベルなら sysrec は書き出しを省いて exit 3 を返す。呼び出し側は元ファイルを
// そのまま使う（＝意味の無い再エンコードをしない）。
async function testNormalizeUnchangedKeepsOriginal() {
  console.log("\n[10b] normalize が「変更不要」(exit 3) なら元ファイルを据え置く");
  const { ctx, recDir } = makeCtx("norm-skip");
  const { sessionId, out } = await api.startRecording(ctx, startOpts(recDir, "mic", "norm2b"));
  process.env.FAKE_NORMALIZE_UNCHANGED = "1";
  const ev = await api.stopRecording(ctx, sessionId);
  delete process.env.FAKE_NORMALIZE_UNCHANGED;
  ok(ev.event === "stopped", `event=stopped（実際: ${ev.event}）`);
  ok(
    !fs.readFileSync(out, "utf8").includes("fake-normalized"),
    "変更不要なら差し替えず元ファイルのまま"
  );
  ok(exists(out) && ev.bytes > 0, "録音ファイルは残る");
  ok(!exists(`${out}.norm.m4a`), "一時ファイルが残らない");
}

// バイナリはプラグイン本体と別配布なので「main.js だけ更新」が起きる。古いバイナリは
// 新しい引数を黙って無視して 0 バイトの録音を作るため、録音を始める前に弾く。
async function testOldBinaryRejectedAtStart() {
  console.log("\n[10c] 古い sysrec は録音開始前に弾く（版数ハンドシェイク）");
  const { ctx, recDir, paths } = makeCtx("old-bin");
  process.env.FAKE_OLD_BINARY = "1";
  let err = null;
  try {
    await api.startRecording(ctx, startOpts(recDir, "mic", "oldbin"));
  } catch (e) {
    err = e;
  } finally {
    delete process.env.FAKE_OLD_BINARY;
  }
  ok(err !== null, "古いバイナリでは startRecording が失敗する");
  ok(
    err && /古い/.test(err.message) && /sysrec を取得/.test(err.message),
    "原因と直し方（sysrec を取得）を伝える文言になっている"
  );
  // sysrec を起動する前に弾くので、セッションディレクトリすら作られない。
  const leftovers = exists(paths.sessionsDir) ? fs.readdirSync(paths.sessionsDir) : [];
  ok(leftovers.length === 0, "起動前に弾くのでセッションを残さない");
}

async function testNormalizeFailKeepsRecording() {
  console.log("\n[11] normalize 失敗でも録音は失わない（元ファイル温存）");
  const { ctx, recDir } = makeCtx("norm-fail");
  const { sessionId, out } = await api.startRecording(ctx, {
    ...startOpts(recDir, "mic", "norm3"),
    agc: false,
  });
  process.env.FAKE_NORMALIZE_FAIL = "1";
  const ev = await api.stopRecording(ctx, sessionId);
  delete process.env.FAKE_NORMALIZE_FAIL;
  ok(ev.event === "stopped", `normalize 失敗でも event=stopped（実際: ${ev.event}）`);
  ok(exists(out) && ev.bytes > 0, "元の録音ファイルがそのまま残る");
  ok(!exists(`${out}.norm.m4a`), "失敗した一時ファイルは掃除される");
}

// ====================================================================
// Windows の仕上げ正規化（取り込み時）。macOS の `sysrec normalize` に相当する段で、
// 狙いは「録音レベルを OS の出力音量から独立させる」こと。Windows 実機が無いので、
// 中核の純関数を数値で検証する。
function testWebNormalizerCore() {
  console.log("\n[13] Windows 仕上げ正規化の中核ロジック（出力音量からの独立）");
  const dt = 0.1;

  // ヘルパ: 一定 RMS を sec 秒ぶん流したあとの状態。
  const feed = (rms, sec, s = api.initialNormalizerState()) => {
    for (let i = 0; i < Math.round(sec / dt); i++) s = api.nextNormalizerState(rms, s, dt);
    return s;
  };

  // 1) ウォームアップ中はゲインを動かさない（冒頭の一瞬で暴れない）。
  const warm = feed(0.05, api.NORM_WARMUP_SEC - 0.3);
  ok(warm.gain === 1, `有音 ${api.NORM_WARMUP_SEC}s 未満ではゲイン 1.0 のまま（実際: ${warm.gain}）`);

  // 2) 十分流せば目標 -16 dBFS へ収束する。
  const conv = feed(0.05, 40);
  const want = api.NORM_TARGET_RMS / 0.05;
  ok(
    Math.abs(conv.gain - want) / want < 0.02,
    `目標 -16 dBFS へ収束（狙い ${want.toFixed(2)} / 実際 ${conv.gain.toFixed(2)}）`
  );

  // 3) **これが本題**: 出力音量で入力が半分になっても、最終的な出力レベルは同じになる。
  //    Windows のループバックは出力音量の影響を受けるため、ここが独立していないと困る。
  const loud = feed(0.08, 40);
  const quiet = feed(0.04, 40); // 出力音量を半分に絞った相当（-6 dB）
  const outLoud = 0.08 * loud.gain;
  const outQuiet = 0.04 * quiet.gain;
  ok(
    Math.abs(outLoud - outQuiet) / outLoud < 0.02,
    `入力が半分でも出力レベルは一致＝出力音量から独立（${outLoud.toFixed(3)} vs ${outQuiet.toFixed(3)}）`
  );

  // 4) 上限クランプ +18 dB。ゲート超え(>0.0079)だが目標まで 8 倍以上要る入力で確認する。
  const tiny = feed(0.01, 60);
  ok(
    Math.abs(tiny.gain - api.NORM_MAX_GAIN) / api.NORM_MAX_GAIN < 0.02,
    `小さい入力は +18 dB でクランプ（実際: ${tiny.gain.toFixed(2)}）`
  );
  // 過大入力は下げる（RMS は 1.0 が上限なので下限クランプ -18dB には実際には届かない）。
  const huge = feed(0.9, 60);
  ok(
    huge.gain < 0.2 && huge.gain >= api.NORM_MIN_GAIN,
    `過大入力は下げる・下限を割らない（実際: ${huge.gain.toFixed(3)}）`
  );

  // 5) 出力音量を絞りすぎて素材全体がゲート(-42 dBFS)未満でも救済する（macOS と同じ）。
  //    ここが無いと「一番救済が要る素材ほど無補正」になる（Issue #4 と同じ穴）。
  const belowGate = feed(0.004, 60);
  ok(
    belowGate.gain > 4,
    `全体がゲート未満でもゲート無しで測り直して持ち上げる（実際: ${belowGate.gain.toFixed(2)}）`
  );

  // 6) ただし実質デジタル無音（-74 dBFS 未満）は素通し（ノイズを増幅しない）。
  const silent = feed(0.00005, 60);
  ok(silent.gain === 1, `実質無音では素通し（実際: ${silent.gain}）`);

  // 6) 無音区間は測定に含めない（会話の合間でゲインが動かない＝静的に保たれる）。
  const speech = feed(0.05, 30);
  const withGaps = feed(api.NORM_GATE_RMS / 2, 30, feed(0.05, 30));
  ok(
    Math.abs(withGaps.gain - speech.gain) / speech.gain < 0.02,
    `無音を挟んでもゲインは動かない（${speech.gain.toFixed(3)} → ${withGaps.gain.toFixed(3)}）`
  );

  // 7) 収束後は安定＝静的ゲインとして振る舞う（累積平均なので後半ほど動かない）。
  const a = feed(0.05, 60);
  const b = feed(0.05, 10, a);
  ok(
    Math.abs(b.gain - a.gain) / a.gain < 0.005,
    `収束後は静的（60s: ${a.gain.toFixed(4)} → 70s: ${b.gain.toFixed(4)}）`
  );
}

// ====================================================================
// Windows(Web Audio) の AGC 中核。macOS の sysrec AGCProcessor と同じ挙動になっているかを
// 数値で確認する（Windows 実機が無くても回帰を検出できるようにするため）。
function testWebAgcCore() {
  console.log("\n[12] Windows AGC の中核ロジック（macOS AGCProcessor と同値）");
  const dt = 0.1;

  // 1) 小さい音（-40 dBFS ≒ 0.01）は目標 -20 dBFS(0.1) へ向けて持ち上げる。冒頭は即時追従。
  const quiet = api.nextAgcState(0.01, api.initialAgcState(), dt);
  ok(quiet.locked, "最初の有音チャンクで即時追従（locked）");
  ok(
    Math.abs(quiet.gain - api.AGC_MAX_GAIN) < 1e-9,
    `小さい音は最大ゲイン +12dB でクランプ（実際: ${quiet.gain.toFixed(3)}）`
  );

  // 2) 過大入力は下げる。ただし最小ゲイン -18dB でクランプ。
  const loud = api.nextAgcState(1.0, api.initialAgcState(), dt);
  ok(
    Math.abs(loud.gain - api.AGC_MIN_GAIN) < 1e-9,
    `過大入力は最小ゲイン -18dB でクランプ（実際: ${loud.gain.toFixed(3)}）`
  );

  // 3) ちょうど目標レベルなら 1.0 のまま。
  const onTarget = api.nextAgcState(api.AGC_TARGET_RMS, api.initialAgcState(), dt);
  ok(Math.abs(onTarget.gain - 1) < 1e-9, "目標レベルちょうどならゲイン 1.0");

  // 4) ゲート未満（無音・ノイズ床）はブーストせず 1.0 へ戻り、再アームされる。
  let s = { gain: 4, locked: true };
  for (let i = 0; i < 40; i++) s = api.nextAgcState(api.AGC_GATE_RMS / 2, s, dt);
  ok(s.gain === 1 && !s.locked, `無音ではゲインが 1.0 へ戻り再アーム（実際: ${s.gain}）`);

  // 5) 上げは遅く・下げは速い（tau 3.0 / 0.4）。同じ dt での移動量で比較する。
  const up = api.nextAgcState(0.01, { gain: 1, locked: true }, dt).gain - 1;
  const down = 1 - api.nextAgcState(1.0, { gain: 1, locked: true }, dt).gain;
  ok(down > up, `下げのほうが速く追従する（上げ ${up.toFixed(4)} < 下げ ${down.toFixed(4)}）`);

  // 6) RMS 計算（フルスケール正弦波は 1/√2 ≒ 0.707）。
  const sine = new Float32Array(1024);
  for (let i = 0; i < sine.length; i++) sine[i] = Math.sin((2 * Math.PI * i) / 64);
  ok(Math.abs(api.rmsOf(sine) - Math.SQRT1_2) < 0.01, "rmsOf: 正弦波の RMS が 1/√2");
  ok(api.rmsOf(new Float32Array(256)) === 0, "rmsOf: 無音は 0");
}

// ====================================================================
try {
  testWebAgcCore();
  testWebNormalizerCore();
  await testSingle();
  await testBothMixOk();
  await testMixFailThenRemix();
  await testRescueRename();
  await testSweep();
  await testStartError();
  await testRestoreClassify();
  await testWatcherExternalStop();
  await testSingleNormalizeWhenAgcOff();
  await testSingleNormalizeWhenAgcOn();
  await testNormalizeUnchangedKeepsOriginal();
  await testOldBinaryRejectedAtStart();
  await testNormalizeFailKeepsRecording();
} catch (e) {
  console.error("\n予期しないエラー:", e);
  fail++;
} finally {
  try { fs.unlinkSync(bundlePath); } catch {}
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
