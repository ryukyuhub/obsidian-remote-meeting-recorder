import { App, Notice, TFile } from "obsidian";
import * as fs from "fs";
import * as path from "path";
import type RemoteMeetingRecorderPlugin from "../main";
import type { TranscriptPostAction } from "../settings";
import { decodeToPcm16k, f32ToB64 } from "./pcm";
import { WhisperClient, type ActionsResult } from "./whisperClient";
import { computeVaultRelative } from "../ui/embed";

function readArrayBuffer(p: string): ArrayBuffer {
  const buf = fs.readFileSync(p);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

/**
 * 録音後 一括文字起こし（設計書 §15.2 ①・sysrec 無改修）。
 * m4a → 16kHz mono PCM → Whisper サーバ → 全文（＋任意で AI 要約）→ ノート追記。
 * 埋め込み先ノート（開始時にキャプチャ）があればそこへ、無ければ録音の隣にコンパニオンノート。
 */
export async function runTranscription(
  plugin: RemoteMeetingRecorderPlugin,
  audioPath: string,
  target: TFile | null
): Promise<void> {
  const s = plugin.settings;
  const client = new WhisperClient(s.whisperServerUrl);
  const notice = new Notice("文字起こし中…（Whisper）", 0);
  try {
    const health = await client.health();
    if (!health) {
      notice.hide();
      new Notice(
        `Whisper サーバに接続できません（${s.whisperServerUrl}）。起動と設定を確認してください。`,
        10000
      );
      return;
    }

    const bytes = readArrayBuffer(audioPath);
    const pcm = await decodeToPcm16k(bytes);
    const b64 = f32ToB64(pcm);

    const tr = await client.transcribe(b64, {
      language: s.transcribeLanguage || "auto",
      model: s.whisperModel || undefined,
    });
    const text = (tr.text || "").trim();
    if (!text) {
      notice.hide();
      new Notice("文字起こし結果が空でした（無音の可能性）。");
      return;
    }

    let summary = "";
    let actions: ActionsResult | null = null;
    const wantSummary = s.summarizeOnTranscribe && s.transcriptPostAction !== "transcript";
    if (wantSummary) {
      if (!s.aiApiKey) {
        new Notice("AI キーが未設定のため要約をスキップしました。");
      } else {
        const ai = { provider: s.aiProvider, apiKey: s.aiApiKey, model: s.aiModel || undefined };
        try {
          summary = (await client.summarize(text, ai)).summary?.trim() ?? "";
          actions = await client.extractActions(text, ai);
        } catch (e) {
          new Notice(`要約に失敗（文字起こしは保存します）: ${(e as Error).message}`);
        }
      }
    }

    const md = buildMarkdown(s.transcriptPostAction, text, summary, actions, tr.detected_language);
    await appendResult(plugin.app, target, audioPath, md, s.saveInVault);

    notice.hide();
    new Notice("文字起こしが完了しました。");
  } catch (e) {
    notice.hide();
    new Notice(`文字起こしに失敗: ${(e as Error).message}`, 10000);
  }
}

function buildMarkdown(
  action: TranscriptPostAction,
  text: string,
  summary: string,
  actions: ActionsResult | null,
  lang?: string
): string {
  const out: string[] = [];
  out.push(`\n> [!note] 文字起こし${lang ? `（${lang}）` : ""}`);

  const wantSummary = action === "summary" || action === "full";
  if (wantSummary && summary) {
    out.push(`\n### 要約\n${summary}`);
  }
  if (wantSummary && actions) {
    const items = actions.action_items ?? [];
    if (items.length) {
      out.push(`\n### アクションアイテム`);
      for (const a of items) {
        const who = a.owner ? ` @${a.owner}` : "";
        const due = a.due ? `（${a.due}）` : "";
        out.push(`- [ ] ${a.task ?? ""}${who}${due}`);
      }
    }
    const decisions = actions.decisions ?? [];
    if (decisions.length) {
      out.push(`\n### 決定事項`);
      for (const d of decisions) out.push(`- ${d}`);
    }
    const followUps = actions.follow_ups ?? [];
    if (followUps.length) {
      out.push(`\n### フォローアップ`);
      for (const f of followUps) out.push(`- ${f}`);
    }
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
  md: string,
  saveInVault: boolean
): Promise<void> {
  // 1) 開始時ノート（埋め込み先）に追記
  if (target) {
    await app.vault.append(target, md);
    return;
  }
  // 2) 録音の隣にコンパニオンノート
  if (saveInVault) {
    const rel = computeVaultRelative(app, audioPath);
    if (rel) {
      const notePath = rel.replace(/\.m4a$/i, ".md");
      let file = app.vault.getAbstractFileByPath(notePath);
      if (!file) {
        const stem = path.basename(notePath, ".md");
        file = await app.vault.create(notePath, `# ${stem}\n\n![[${rel}]]\n`);
      }
      if (file instanceof TFile) {
        await app.vault.append(file, md);
        return;
      }
    }
  }
  new Notice("文字起こし結果の保存先ノートが見つかりませんでした。");
}
