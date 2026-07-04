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
    const text = await transcribeViaWhisperCpp(plugin, audioPath);

    if (text == null) {
      notice.hide();
      return; // エラーは各 backend 内で Notice 済み
    }
    if (!text.trim()) {
      notice.hide();
      new Notice("文字起こし結果が空でした（無音の可能性）。");
      return;
    }

    const md = buildMarkdown(text.trim(), s.transcribeLanguage);
    // linkToDailyNote オン時はデイリーノートへ埋め込みリンクを別経路で追記済みなので二重埋め込みを避ける
    await appendResult(plugin.app, target, audioPath, md, !s.linkToDailyNote);

    notice.hide();
    new Notice("文字起こしが完了しました。");
  } catch (e) {
    notice.hide();
    new Notice(`文字起こしに失敗: ${(e as Error).message}`, 10000);
  }
}

/** whisper.cpp（同梱バイナリ）で文字起こし。失敗時は Notice して null。 */
async function transcribeViaWhisperCpp(
  plugin: RemoteMeetingRecorderPlugin,
  audioPath: string
): Promise<string | null> {
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
  const wavBuf = pcmToWav(pcm, 16000);
  const base = path.join(os.tmpdir(), `rmr-tx-${process.pid}-${pcm.length}`);
  const wavPath = `${base}.wav`;
  fs.writeFileSync(wavPath, Buffer.from(wavBuf));
  try {
    return await transcribeWav(bin, model, wavPath, s.transcribeLanguage || "auto", base);
  } finally {
    try {
      fs.unlinkSync(wavPath);
    } catch {
      // 無視
    }
  }
}

function buildMarkdown(text: string, lang?: string): string {
  const heading = `\n> [!note] 文字起こし${lang && lang !== "auto" ? `（${lang}）` : ""}`;
  return `${heading}\n\n### 全文\n${text}\n`;
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
