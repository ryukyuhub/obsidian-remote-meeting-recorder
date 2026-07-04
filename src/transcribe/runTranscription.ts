import { App, Notice, TFile } from "obsidian";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type RemoteMeetingRecorderPlugin from "../main";
import { decodeToPcm16k, pcmToWav } from "./pcm";
import { transcribeWav } from "./whisperCppClient";
import { resolveWhisperBin, resolveWhisperModel } from "./resolveWhisper";
import { computeVaultRelative } from "../ui/embed";
import { resolveDailyNote } from "../ui/dailyNote";

function readArrayBuffer(p: string): ArrayBuffer {
  const buf = fs.readFileSync(p);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

/**
 * 録音後 一括文字起こし（設計書 §15.2 ①・sysrec 無改修）。
 * バックエンドは同梱の whisper.cpp（サーバ不要・オフライン）。
 * m4a → 16kHz mono PCM → WAV → whisper-cli → ノート追記。
 */
export async function runTranscription(
  plugin: RemoteMeetingRecorderPlugin,
  audioPath: string,
  target: TFile | null
): Promise<void> {
  const s = plugin.settings;
  const notice = new Notice("文字起こし中…", 0);
  try {
    const result = await transcribeViaWhisperCpp(plugin, audioPath);

    if (result == null) {
      notice.hide();
      return; // エラーは各 backend 内で Notice 済み
    }
    if (!result.text.trim()) {
      notice.hide();
      new Notice("文字起こし結果が空でした（無音の可能性）。");
      return;
    }

    const range = recordingTimeRange(audioPath, result.durationSec);
    const md = buildMarkdown(result.text.trim(), range, s.transcribeLanguage);
    // linkToDailyNote オン時はデイリーノートへ埋め込みリンクを別経路で追記済みなので二重埋め込みを避ける
    await appendResult(plugin.app, target, audioPath, md, !s.linkToDailyNote);

    notice.hide();
    new Notice("文字起こしが完了しました。");
  } catch (e) {
    notice.hide();
    new Notice(`文字起こしに失敗: ${(e as Error).message}`, 10000);
  }
}

/** whisper.cpp（同梱バイナリ）で文字起こし。全文と録音長（16kHz PCM から算出）を返す。失敗時は Notice して null。 */
async function transcribeViaWhisperCpp(
  plugin: RemoteMeetingRecorderPlugin,
  audioPath: string
): Promise<{ text: string; durationSec: number } | null> {
  const s = plugin.settings;
  const pluginDir = plugin.getPluginDir();
  const bin = resolveWhisperBin(pluginDir, s.whisperCppBinPath);
  if (!bin) {
    new Notice(
      "whisper.cpp が見つかりません。診断（doctor）でビルド/取得するか、brew install whisper-cpp してください。",
      10000
    );
    return null;
  }
  const model = resolveWhisperModel(pluginDir, s.whisperCppModel);
  if (!model) {
    new Notice("Whisper モデルが見つかりません。診断（doctor）からダウンロードしてください。", 10000);
    return null;
  }

  // m4a → 16kHz mono PCM → WAV（whisper.cpp は m4a 非対応・wav/flac/mp3/ogg のみ）
  const pcm = await decodeToPcm16k(readArrayBuffer(audioPath));
  const durationSec = pcm.length / 16000; // 16kHz mono なのでサンプル数÷16000＝秒
  const wavBuf = pcmToWav(pcm, 16000);
  const base = path.join(os.tmpdir(), `rmr-tx-${process.pid}-${pcm.length}`);
  const wavPath = `${base}.wav`;
  fs.writeFileSync(wavPath, Buffer.from(wavBuf));
  try {
    const text = await transcribeWav(bin, model, wavPath, s.transcribeLanguage || "auto", base);
    return { text, durationSec };
  } finally {
    try {
      fs.unlinkSync(wavPath);
    } catch {
      // 無視
    }
  }
}

function buildMarkdown(text: string, dateTime: string, lang?: string): string {
  const heading = `\n> [!note] 文字起こし${lang && lang !== "auto" ? `（${lang}）` : ""}`;
  return `${heading}\n\n### ${dateTime}\n${text}\n`;
}

/**
 * 録音の時間帯（見出し用）を `YYYY-MM-DD HH:MM〜HH:MM` で返す。
 * 開始は既定命名 `YYYY-MM-DD-HHMM` から復元（カスタム名等ならファイル更新時刻を終了とみなし
 * 録音長ぶんさかのぼる）。終了は開始＋録音長。日をまたぐ場合は終了側にも日付を付ける。
 */
function recordingTimeRange(audioPath: string, durationSec: number): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  const date = (d: Date): string => `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  const hm = (d: Date): string => `${p(d.getHours())}:${p(d.getMinutes())}`;

  const start = recordingStart(audioPath, durationSec);
  const end = new Date(start.getTime() + Math.max(0, durationSec) * 1000);

  return date(start) === date(end)
    ? `${date(start)} ${hm(start)}〜${hm(end)}`
    : `${date(start)} ${hm(start)}〜${date(end)} ${hm(end)}`;
}

/** 録音開始時刻。ファイル名（既定命名）優先、なければ更新時刻−録音長。 */
function recordingStart(audioPath: string, durationSec: number): Date {
  const stem = path.basename(audioPath).replace(/\.[^./]+$/, "");
  const m = stem.match(/(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  try {
    const endMs = fs.statSync(audioPath).mtimeMs;
    return new Date(endMs - Math.max(0, durationSec) * 1000);
  } catch {
    return new Date();
  }
}

async function appendResult(
  app: App,
  target: TFile | null,
  audioPath: string,
  md: string,
  includeDailyEmbed: boolean
): Promise<void> {
  // 1) 指定ノート（開始時ノート or アクティブノート）→ そのまま追記
  if (target) {
    await app.vault.append(target, md);
    return;
  }

  // 未選択時は音声への埋め込みリンクも併記して録音を辿れるようにする（Vault 内のときだけ）
  const rel = computeVaultRelative(app, audioPath);
  const block = rel && includeDailyEmbed ? `\n![[${rel}]]\n${md}` : md;

  // 2) 未選択 → 今日のデイリーノート（コア「デイリーノート」有効時）
  const daily = await resolveDailyNote(app);
  if (daily) {
    await app.vault.append(daily, block);
    return;
  }

  // 3) デイリーノート無効 & Vault 内の録音 → 隣にコンパニオンノート（拡張子は汎用的に .md へ）
  if (rel) {
    const notePath = rel.replace(/\.[^./]+$/, ".md");
    const file = await ensureNote(app, notePath, `![[${rel}]]\n`);
    if (file) {
      await app.vault.append(file, md);
      return;
    }
  }

  // 4) Vault 外 → Vault ルートに新規ノート
  const stem = path.basename(audioPath).replace(/\.[^./]+$/, "");
  const file = await ensureNote(app, `文字起こし-${stem}.md`, `# ${stem}\n`);
  if (file) {
    await app.vault.append(file, md);
    return;
  }
  new Notice("文字起こし結果の保存先ノートを作成できませんでした。");
}

async function ensureNote(app: App, notePath: string, initial: string): Promise<TFile | null> {
  const existing = app.vault.getAbstractFileByPath(notePath);
  if (existing instanceof TFile) return existing;
  if (existing) return null; // 同名フォルダ等
  try {
    const stem = path.basename(notePath, ".md");
    return await app.vault.create(notePath, `# ${stem}\n\n${initial}`);
  } catch {
    return null;
  }
}
