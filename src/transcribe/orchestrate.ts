// 文字起こしの起動オーケストレーション（リファクタ調査 R5 で main.ts から移設）。
// 「どの音声を・どのノート文脈で・どのオプションで」文字起こしするかの入口を集約する。
// 実処理は runTranscribeJob / runTranscription（従来どおり）。
import { Notice, TFile } from "obsidian";
import * as path from "path";
import type RemoteMeetingRecorderPlugin from "../main";
import { getVaultBasePath } from "../context";
import { computeVaultRelative } from "../ui/embed";
import { findExistingTranscript, findEmbedLine } from "./insertTranscript";
import { runTranscribeJob } from "./job";
import { TranscribeOptionsModal } from "../ui/TranscribeOptionsModal";

export interface TranscribeContext {
  audioPath: string;
  audioRel: string | null;
  note: TFile | null;
  anchorLine?: number;
}

/** 既存の録音ファイルを手動で文字起こし（オプション選択 → 既存フォールバックへ挿入）。 */
export async function transcribeFile(
  plugin: RemoteMeetingRecorderPlugin,
  audioPath: string
): Promise<void> {
  const audioRel = computeVaultRelative(plugin.app, audioPath);
  await openTranscribeOptions(plugin, { audioPath, audioRel, note: null });
}

/** ファイルエクスプローラの音声ファイルを文字起こし（ノート文脈なし → フォールバック）。 */
export async function transcribeAudioFile(
  plugin: RemoteMeetingRecorderPlugin,
  file: TFile
): Promise<void> {
  const base = getVaultBasePath(plugin.app);
  if (!base) {
    new Notice("Vault パスを取得できません。");
    return;
  }
  await openTranscribeOptions(plugin, {
    audioPath: path.join(base, file.path),
    audioRel: file.path,
    note: null,
  });
}

/** 埋め込み音声の文字起こし（結果は埋め込み直下へ挿入・重複は検出して選択）。 */
export async function transcribeEmbed(
  plugin: RemoteMeetingRecorderPlugin,
  audio: TFile,
  note: TFile | null,
  anchorLine?: number,
  srcHint?: string
): Promise<void> {
  const base = getVaultBasePath(plugin.app);
  if (!base) {
    new Notice("Vault パスを取得できません。");
    return;
  }
  let line = anchorLine;
  if (line == null && note) line = await resolveEmbedLine(plugin, note, audio, srcHint);
  await openTranscribeOptions(plugin, {
    audioPath: path.join(base, audio.path),
    audioRel: audio.path,
    note,
    anchorLine: line,
  });
}

/** ノート本文から音声埋め込み行（0 始まり）を探す。見つからなければ undefined。 */
async function resolveEmbedLine(
  plugin: RemoteMeetingRecorderPlugin,
  note: TFile,
  audio: TFile,
  srcHint?: string
): Promise<number | undefined> {
  let content: string;
  try {
    content = await plugin.app.vault.read(note);
  } catch {
    return undefined;
  }
  // src（埋め込みに書かれたリンクテキスト）優先、無ければ Vault 相対パスで照合
  return findEmbedLine(content.split("\n"), srcHint ?? audio.path, audio.name);
}

/** 文字起こしの実行オプション（毎回モデル/言語/重複時の扱い）を出してから実行する。 */
export async function openTranscribeOptions(
  plugin: RemoteMeetingRecorderPlugin,
  ctx: TranscribeContext
): Promise<void> {
  // 既存トランスクリプトの有無（モーダルで 置換/追記/中止 を出すかの判定）
  let existing = false;
  if (ctx.note) {
    try {
      const lines = (await plugin.app.vault.read(ctx.note)).split("\n");
      const anchor =
        ctx.anchorLine ?? findEmbedLine(lines, ctx.audioRel, path.basename(ctx.audioPath));
      existing = findExistingTranscript(lines, anchor) != null;
    } catch {
      /* 読めなければ既存なし扱い */
    }
  }
  const audioName = path.basename(ctx.audioPath);
  new TranscribeOptionsModal(plugin, audioName, existing, (opts) => {
    void runTranscribeJob(plugin, {
      audioPath: ctx.audioPath,
      audioRel: ctx.audioRel,
      note: ctx.note,
      anchorLine: ctx.anchorLine,
      model: opts.model,
      language: opts.language,
      dupMode: opts.dupMode,
    });
  }).open();
}
