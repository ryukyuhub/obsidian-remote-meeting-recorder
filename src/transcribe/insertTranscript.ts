import { App, MarkdownView, TFile } from "obsidian";
import * as path from "path";
import { wikilinkEmbed } from "../ui/embed";
import { resolveDailyNote } from "../ui/dailyNote";

/* 右クリック文字起こしの結果挿入（冪等・重複防止・設計書 §15.2 の手動起点）。
 *
 * 挿入は停止時 自動文字起こしと同一のプレーンなコールアウト（マーカー無し）。
 * 「同一音声への再実行」は、その音声の埋め込み `![[…]]` を手がかりに直後のトランスクリプトを
 * 特定して置換する。これによりノートに不可視コメント等のゴミを残さず、見た目のフォーマットも
 * 既存と完全に一致する（§6 受け入れ基準）。 */

/** 旧版が挿入していた不可視マーカー（再文字起こし時に掃除して除去するために検出する）。 */
const LEGACY_MARK_OPEN = /^%%rmr-tx:.*%%$/;
const LEGACY_MARK_CLOSE = "%%/rmr-tx%%";

/** 音声埋め込み行を探す手がかり。 */
export interface EmbedHint {
  /** Vault 相対パス（Vault 外なら null）。一意に当てるため優先的に照合。 */
  rel: string | null;
  /** ファイル名（拡張子込み）。rel が無い/当たらないときの照合に使う。 */
  name: string;
}

/** 本文から音声埋め込み `![[…]]` 行（0 始まり）を探す。見つからなければ undefined。 */
export function findEmbedLine(lines: string[], rel: string | null, name: string): number | undefined {
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l.includes("![[")) continue;
    if (rel && l.includes(rel)) return i;
    if (l.includes(name)) return i;
  }
  return undefined;
}

/** 既存トランスクリプトの行範囲（[startLine, endLineExclusive)）。 */
export interface ExistingRange {
  startLine: number;
  endLineExclusive: number;
}

/**
 * 埋め込み行 anchorLine の直後にある既存トランスクリプト（`> [!note] 文字起こし` コールアウト）を探す。
 * 旧版の不可視マーカー（%%rmr-tx:…%% … %%/rmr-tx%%）が付いていればそれも範囲に含め、置換時に一緒に掃除する。
 * anchorLine が無い／直後にトランスクリプトが無ければ null。
 *
 * マーカー無しブロックは終端が曖昧なため、本文開始後の最初の空行で打ち切る（控えめに選ぶ）。
 * 過剰選択でユーザーの後続段落を消すより、過少選択で古い断片が残る方が安全（データを失わない）。
 */
export function findExistingTranscript(
  lines: string[],
  anchorLine?: number
): ExistingRange | null {
  if (anchorLine == null) return null;

  let i = anchorLine + 1;
  while (i < lines.length && lines[i].trim() === "") i++;

  // 旧マーカー開始行があれば取り込み、その次の実体（コールアウト）まで進む
  let markerStart: number | null = null;
  if (i < lines.length && LEGACY_MARK_OPEN.test(lines[i].trim())) {
    markerStart = i;
    i++;
    while (i < lines.length && lines[i].trim() === "") i++;
  }

  if (i >= lines.length || !/^>\s*\[!note\]\s*文字起こし/.test(lines[i].trim())) {
    return null; // 直後にトランスクリプトは無い
  }

  let start = markerStart ?? i;
  i++; // コールアウト見出しの次から本文
  let seenBody = false;
  while (i < lines.length) {
    const t = lines[i].trim();
    if (t === LEGACY_MARK_CLOSE) {
      i++; // 旧マーカー終了行も範囲に含めて掃除
      break;
    }
    if (/^!\[\[/.test(t)) break; // 次の埋め込み
    if (LEGACY_MARK_OPEN.test(t)) break; // 次のブロックのマーカー
    if (/^>\s*\[!/.test(t)) break; // 次のコールアウト
    if (/^#{1,2}\s/.test(t)) break; // 次の見出し（### は本文内なので対象外）
    if (t === "") {
      if (seenBody) break; // 本文の後の最初の空行で終端
      i++;
      continue; // 見出し直後の空行（### の前）はスキップ
    }
    seenBody = true;
    i++;
  }
  let end = i;
  while (end > start && lines[end - 1].trim() === "") end--; // 末尾空行を戻す
  if (start > 0 && lines[start - 1].trim() === "") start--; // 先頭側の空行を取り込む
  return { startLine: start, endLineExclusive: end };
}

export type DupMode = "replace" | "append";

/**
 * 可視ブロック（buildMarkdown の出力）を先頭空行付きの行配列にする。
 * 末尾に空行は付けない: 検出（findExistingTranscript）は末尾空行を範囲に含めないため、
 * 末尾空行を付けると置換のたびに空行が増えてしまう（冪等性のため先頭空行のみ）。
 */
function blockLines(md: string): string[] {
  return ["", ...md.trim().split("\n")];
}

interface UpsertOptions {
  /** 埋め込み行（0 始まり）。未指定なら embedHint から探す。 */
  anchorLine?: number;
  /** 埋め込み行を探す手がかり（anchorLine 未指定時）。 */
  embedHint?: EmbedHint;
  /** 既存検出時の扱い。既定は置換（再文字起こしで上書き）。 */
  dupMode?: DupMode;
  /** 既存も埋め込みも無いときに、先頭へ付ける埋め込みリンク（Vault 相対）。 */
  prependEmbed?: string | null;
}

/**
 * ノートへトランスクリプトを冪等に挿入する。
 * 同一音声の埋め込み直後に既存があれば dupMode に従い 置換 / 直後へ追記。
 * 無ければ埋め込み直下（埋め込みも無ければ末尾）へ挿入。
 */
export async function upsertTranscript(
  app: App,
  note: TFile,
  md: string,
  opts: UpsertOptions = {}
): Promise<void> {
  const dupMode = opts.dupMode ?? "replace";
  const content = await app.vault.read(note);
  const lines = content.split("\n");
  const anchor =
    opts.anchorLine ??
    (opts.embedHint ? findEmbedLine(lines, opts.embedHint.rel, opts.embedHint.name) : undefined);
  const existing = findExistingTranscript(lines, anchor);
  const block = blockLines(md);

  if (existing) {
    if (dupMode === "append") {
      lines.splice(existing.endLineExclusive, 0, ...block);
    } else {
      lines.splice(existing.startLine, existing.endLineExclusive - existing.startLine, ...block);
    }
  } else {
    const head = opts.prependEmbed ? ["", wikilinkEmbed(opts.prependEmbed)] : [];
    const at = anchor != null ? anchor + 1 : lines.length;
    lines.splice(at, 0, ...head, ...block);
  }

  await app.vault.modify(note, lines.join("\n"));
}

/** 挿入先ノートと、新規作成時に先頭へ付ける埋め込みリンク。 */
export interface InsertTarget {
  note: TFile;
  prependEmbed: string | null;
}

/**
 * ノート文脈が無い起点（ファイルエクスプローラ／コマンド）の挿入先を解決する。
 * 既存 appendResult と同じ優先順位（設計書 §15.2）:
 *   アクティブノート → 今日のデイリーノート → 音声隣の同名ノート → Vault ルートの新規ノート。
 */
export async function resolveInsertTarget(
  app: App,
  audioPath: string,
  audioRel: string | null
): Promise<InsertTarget | null> {
  // 1) アクティブな md ノート
  const active = app.workspace.getActiveViewOfType(MarkdownView)?.file ?? null;
  if (active) return { note: active, prependEmbed: null };

  // 2) 今日のデイリーノート（有効時）— 新規なら埋め込みリンクも併記
  const daily = await resolveDailyNote(app);
  if (daily) return { note: daily, prependEmbed: audioRel };

  // 3) Vault 内音声 → 隣の同名ノート
  if (audioRel) {
    const notePath = audioRel.replace(/\.[^./]+$/, ".md");
    const file = await ensureNote(app, notePath, `${wikilinkEmbed(audioRel)}\n`);
    if (file) return { note: file, prependEmbed: null };
  }

  // 4) Vault 外 → ルートに新規ノート
  const stem = path.basename(audioPath).replace(/\.[^./]+$/, "");
  const file = await ensureNote(app, `文字起こし-${stem}.md`, `# ${stem}\n`);
  if (file) return { note: file, prependEmbed: null };

  return null;
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
