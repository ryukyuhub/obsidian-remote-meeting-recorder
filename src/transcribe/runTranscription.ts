import { App, Notice, TFile } from "obsidian";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type RemoteMeetingRecorderPlugin from "../main";
import type { TranscriptPostAction } from "../settings";
import { decodeToPcm16k, f32ToB64, pcmToWav } from "./pcm";
import { WhisperClient } from "./whisperClient";
import { transcribeWav } from "./whisperCppClient";
import { resolveWhisperBin, resolveWhisperModel } from "./resolveWhisper";
import { summarizeWithAnthropic } from "../ai/summarize";
import { computeVaultRelative } from "../ui/embed";

function readArrayBuffer(p: string): ArrayBuffer {
  const buf = fs.readFileSync(p);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

/**
 * 録音後 一括文字起こし（設計書 §15.2 ①・sysrec 無改修）。
 * バックエンド: whisper.cpp 同梱バイナリ（既定・サーバ不要）or ローカル Whisper サーバ。
 * m4a → 16kHz mono PCM → 文字起こし →（任意で AI 要約）→ ノート追記。
 */
export async function runTranscription(
  plugin: RemoteMeetingRecorderPlugin,
  audioPath: string,
  target: TFile | null
): Promise<void> {
  const s = plugin.settings;
  const notice = new Notice("文字起こし中…", 0);
  try {
    const text =
      s.transcribeBackend === "server"
        ? await transcribeViaServer(plugin, audioPath)
        : await transcribeViaWhisperCpp(plugin, audioPath);

    if (text == null) {
      notice.hide();
      return; // エラーは各 backend 内で Notice 済み
    }
    if (!text.trim()) {
      notice.hide();
      new Notice("文字起こし結果が空でした（無音の可能性）。");
      return;
    }

    let summaryMd = "";
    const wantSummary = s.summarizeOnTranscribe && s.transcriptPostAction !== "transcript";
    if (wantSummary) {
      summaryMd = await summarize(plugin, text);
    }

    const md = buildMarkdown(s.transcriptPostAction, text.trim(), summaryMd, s.transcribeLanguage);
    await appendResult(plugin.app, target, audioPath, md);

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

/** ローカル Whisper サーバで文字起こし。失敗時は Notice して null。 */
async function transcribeViaServer(
  plugin: RemoteMeetingRecorderPlugin,
  audioPath: string
): Promise<string | null> {
  const s = plugin.settings;
  const client = new WhisperClient(s.whisperServerUrl);
  const health = await client.health();
  if (!health) {
    new Notice(
      `Whisper サーバに接続できません（${s.whisperServerUrl}）。起動と設定を確認してください。`,
      10000
    );
    return null;
  }
  const pcm = await decodeToPcm16k(readArrayBuffer(audioPath));
  const b64 = f32ToB64(pcm);
  const tr = await client.transcribe(b64, {
    language: s.transcribeLanguage || "auto",
    model: s.whisperModel || undefined,
  });
  return tr.text || "";
}

/** AI 要約（既定 Anthropic 直接 / openai・ollama はサーバ経由）。失敗は空文字。 */
async function summarize(plugin: RemoteMeetingRecorderPlugin, text: string): Promise<string> {
  const s = plugin.settings;
  try {
    if (s.aiProvider === "anthropic") {
      if (!s.aiApiKey) {
        new Notice("AI キーが未設定のため要約をスキップしました。");
        return "";
      }
      return await summarizeWithAnthropic(text, {
        provider: s.aiProvider,
        apiKey: s.aiApiKey,
        model: s.aiModel,
        language: s.transcribeLanguage,
      });
    }
    // openai / ollama はサーバ /summarize に委譲
    const client = new WhisperClient(s.whisperServerUrl);
    const sm = await client.summarize(text, {
      provider: s.aiProvider,
      apiKey: s.aiApiKey,
      model: s.aiModel || undefined,
    });
    return sm.summary?.trim() ?? "";
  } catch (e) {
    new Notice(`要約に失敗（文字起こしは保存します）: ${(e as Error).message}`);
    return "";
  }
}

function buildMarkdown(
  action: TranscriptPostAction,
  text: string,
  summaryMd: string,
  lang?: string
): string {
  const out: string[] = [];
  out.push(`\n> [!note] 文字起こし${lang && lang !== "auto" ? `（${lang}）` : ""}`);
  if ((action === "summary" || action === "full") && summaryMd) {
    out.push(`\n${summaryMd}`);
  }
  if (action === "transcript" || action === "full") {
    out.push(`\n### 全文\n${text}`);
  }
  return out.join("\n") + "\n";
}

async function appendResult(
  app: App,
  target: TFile | null,
  audioPath: string,
  md: string
): Promise<void> {
  // 1) 指定ノート（開始時ノート or アクティブノート）
  if (target) {
    await app.vault.append(target, md);
    return;
  }
  // 2) Vault 内の録音 → 隣にコンパニオンノート（拡張子は汎用的に .md へ）
  const rel = computeVaultRelative(app, audioPath);
  if (rel) {
    const notePath = rel.replace(/\.[^./]+$/, ".md");
    const file = await ensureNote(app, notePath, `![[${rel}]]\n`);
    if (file) {
      await app.vault.append(file, md);
      return;
    }
  }
  // 3) Vault 外 → Vault ルートに新規ノート
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
