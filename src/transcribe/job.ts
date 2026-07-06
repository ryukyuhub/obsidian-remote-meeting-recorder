import { Notice, TFile } from "obsidian";
import type RemoteMeetingRecorderPlugin from "../main";
import { transcribeAudioToText, buildMarkdown, recordingTimeRange } from "./runTranscription";
import { TranscribeCancelled } from "./whisperCppClient";
import {
  transcriptKey,
  upsertTranscript,
  resolveInsertTarget,
  type DupMode,
} from "./insertTranscript";

/** 右クリック文字起こし1回分の指示。 */
export interface TranscribeJob {
  /** 音声の絶対パス。 */
  audioPath: string;
  /** Vault 相対パス（Vault 外なら null）。挿入先解決・キー生成に使う。 */
  audioRel: string | null;
  /** 挿入先ノート（ノート内トリガー時）。null ならフォールバック解決。 */
  note: TFile | null;
  /** 埋め込み行（0 始まり・ノート内トリガー時）。結果をこの直下へ挿入。 */
  anchorLine?: number;
  /** Whisper モデル（名前）。 */
  model: string;
  /** 言語（ja / en / auto 等）。 */
  language: string;
  /** 既存トランスクリプト検出時の扱い。 */
  dupMode: DupMode;
}

/**
 * 進捗表示（経過秒＋%）＋キャンセルボタン付きの文字起こしを実行し、結果をノートへ冪等に挿入する。
 * UI はブロックしない（Notice のみ）。長尺でも動いていることが分かるよう秒カウンタを回す。
 */
export async function runTranscribeJob(
  plugin: RemoteMeetingRecorderPlugin,
  job: TranscribeJob
): Promise<void> {
  const controller = new AbortController();
  const startedAt = Date.now();
  let phase: "prep" | "run" = "prep";
  let pct = -1;

  const notice = new Notice("", 0);
  const noticeEl = (notice as unknown as { noticeEl: HTMLElement }).noticeEl;
  noticeEl.empty();
  // Notice は既定でクリックすると消えるので、中身をコンテナで包みクリックを止める
  // （進捗中にうっかりキャンセルボタンを失わないように。破棄は finally の hide() だけ）。
  const box = noticeEl.createDiv();
  box.addEventListener("click", (e) => e.stopPropagation());
  const msgEl = box.createDiv();
  const cancelBtn = box.createEl("button", {
    text: "キャンセル",
    cls: ["mod-warning", "rmr-tx-cancel"],
  });
  cancelBtn.addEventListener("click", () => {
    controller.abort();
    cancelBtn.disabled = true;
    cancelBtn.setText("キャンセル中…");
  });

  const render = (): string => {
    const sec = Math.floor((Date.now() - startedAt) / 1000);
    const t = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
    if (phase === "prep") return `文字起こし準備中…（${t}）`;
    return pct >= 0 ? `文字起こし中… ${pct}%（${t}）` : `文字起こし中…（${t}）`;
  };
  msgEl.setText(render());
  const ticker = window.setInterval(() => msgEl.setText(render()), 1000);

  try {
    const result = await transcribeAudioToText(plugin, job.audioPath, {
      model: job.model,
      language: job.language,
      signal: controller.signal,
      onRun: () => {
        phase = "run";
      },
      onProgress: (p) => {
        phase = "run";
        pct = p;
      },
    });

    if (result == null) return; // エラーは transcribeAudioToText 内で Notice 済み
    if (!result.text.trim()) {
      new Notice("文字起こし結果が空でした（無音の可能性）。");
      return;
    }

    const range = recordingTimeRange(job.audioPath, result.durationSec);
    const md = buildMarkdown(result.text.trim(), range, job.language);
    const key = transcriptKey(job.audioRel, job.audioPath);

    if (job.note) {
      await upsertTranscript(plugin.app, job.note, key, md, {
        anchorLine: job.anchorLine,
        dupMode: job.dupMode,
      });
    } else {
      const target = await resolveInsertTarget(plugin.app, job.audioPath, job.audioRel);
      if (!target) {
        new Notice("文字起こし結果の保存先ノートを作成できませんでした。");
        return;
      }
      await upsertTranscript(plugin.app, target.note, key, md, {
        dupMode: job.dupMode,
        prependEmbed: target.prependEmbed,
      });
    }

    new Notice("文字起こしが完了しました。");
  } catch (e) {
    if (e instanceof TranscribeCancelled) {
      new Notice("文字起こしをキャンセルしました。");
      return;
    }
    // Notice は表示が切れるため、原因追跡用にフルのエラー（whisper の stderr 含む）を console にも出す。
    console.error("[remote-meeting-recorder] 文字起こしに失敗", e);
    new Notice(`文字起こしに失敗: ${(e as Error).message}`, 10000);
  } finally {
    window.clearInterval(ticker);
    notice.hide();
  }
}
