import { App, MarkdownView, TFile } from "obsidian";
import * as path from "path";
import { wikilinkEmbed } from "../ui/embed";
import { resolveDailyNote } from "../ui/dailyNote";

/* 右クリック文字起こしの結果挿入（冪等・重複防止・設計書 §15.2 の手動起点）。
 *
 * 挿入したトランスクリプトは不可視のマーカー（Obsidian コメント %% %%）で囲む。
 * これにより「同一音声への再実行」で以前の結果を確実に特定して置換でき、重複挿入を防げる。
 * マーカーは閲覧ビュー・ライブプレビューでは表示されないため、見た目のフォーマットは
 * 既存（停止時 自動文字起こし）と同一を保つ（§6 受け入れ基準）。 */

const MARK_CLOSE = "%%/rmr-tx%%";

/** キーからマーカー開始行を作る。 */
function markOpen(key: string): string {
  return `%%rmr-tx:${key}%%`;
}

/** マーカーキーに使えない文字（% と改行）を除去。 */
function sanitizeKey(k: string): string {
  return k.replace(/%/g, "").replace(/\r?\n/g, " ").trim();
}

/**
 * 音声を一意に指すキー。Vault 内なら相対パス（機種非依存で安定）、外ならファイル名。
 * 同一音声の再文字起こしを検出・置換するために使う。
 */
export function transcriptKey(rel: string | null, audioPath: string): string {
  const id = rel || audioPath.split(/[\\/]/).pop() || audioPath;
  return sanitizeKey(id);
}

/** 可視ブロック（buildMarkdown の出力）をマーカーで囲んだ行配列にする。前後に空行を付ける。 */
function wrappedBlockLines(md: string, key: string): string[] {
  const body = md.trim();
  return ["", markOpen(key), ...body.split("\n"), MARK_CLOSE, ""];
}

/** 既存トランスクリプトの行範囲（[startLine, endLineExclusive)）。 */
export interface ExistingRange {
  startLine: number;
  endLineExclusive: number;
}

/**
 * ノート内の既存トランスクリプトを探す。
 * 1) マーカー付きブロック（キー一致）を最優先で正確に特定。
 * 2) マーカーが無い場合（停止時 自動文字起こし等の旧ブロック）、埋め込み行 anchorLine の
 *    直後にある `> [!note] 文字起こし` コールアウトをヒューリスティックに特定。
 * 見つからなければ null。
 */
export function findExistingTranscript(
  lines: string[],
  key: string,
  anchorLine?: number
): ExistingRange | null {
  // 1) マーカーブロック（キー一致）
  const open = markOpen(key);
  const oi = lines.findIndex((l) => l.trim() === open);
  if (oi !== -1) {
    const ci = lines.findIndex((l, i) => i > oi && l.trim() === MARK_CLOSE);
    if (ci !== -1) {
      let start = oi;
      let end = ci + 1;
      // 挿入時に付けた前後の空行も一緒に取り込む（置換後に空行が増殖しないように）
      if (start > 0 && lines[start - 1].trim() === "") start--;
      if (end < lines.length && lines[end].trim() === "") end++;
      return { startLine: start, endLineExclusive: end };
    }
  }

  // 2) 旧ブロック（マーカー無し）: 埋め込み直後のコールアウト
  if (anchorLine != null) {
    let i = anchorLine + 1;
    while (i < lines.length && lines[i].trim() === "") i++;
    if (i < lines.length && /^>\s*\[!note\]\s*文字起こし/.test(lines[i].trim())) {
      const start = i;
      i++;
      // 本文（見出し行 → 空行 → ### 範囲 → テキスト）を辿る。マーカー無しブロックは終端が曖昧なため、
      // 本文開始後の最初の空行で打ち切る（＝控えめに選ぶ）。過剰選択でユーザーの後続段落を消すより、
      // 過少選択で古い断片が残る方が安全（データを失わない）。
      let seenBody = false;
      while (i < lines.length) {
        const t = lines[i].trim();
        if (/^!\[\[/.test(t)) break; // 次の埋め込み
        if (/^%%rmr-tx:/.test(t)) break; // 次のマーカーブロック
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
      let s = start;
      if (s > 0 && lines[s - 1].trim() === "") s--; // 先頭側の空行を取り込む
      return { startLine: s, endLineExclusive: end };
    }
  }

  return null;
}

export type DupMode = "replace" | "append";

interface UpsertOptions {
  /** 埋め込み行（0 始まり）。既存が無いときここの直後へ挿入。未指定なら末尾。 */
  anchorLine?: number;
  /** 既存検出時の扱い。既定は置換（再文字起こしで上書き）。 */
  dupMode?: DupMode;
  /** 既存が無くノートを新規作成した場合などに、先頭へ付ける埋め込みリンク（Vault 相対）。 */
  prependEmbed?: string | null;
}

/**
 * ノートへトランスクリプトを冪等に挿入する。
 * 既存（同一キー）があれば dupMode に従い 置換 / 直後へ追記。無ければ埋め込み直後（または末尾）へ挿入。
 */
export async function upsertTranscript(
  app: App,
  note: TFile,
  key: string,
  md: string,
  opts: UpsertOptions = {}
): Promise<void> {
  const dupMode = opts.dupMode ?? "replace";
  const content = await app.vault.read(note);
  const lines = content.split("\n");
  const existing = findExistingTranscript(lines, key, opts.anchorLine);
  const block = wrappedBlockLines(md, key);

  if (existing) {
    if (dupMode === "append") {
      lines.splice(existing.endLineExclusive, 0, ...block);
    } else {
      lines.splice(existing.startLine, existing.endLineExclusive - existing.startLine, ...block);
    }
  } else {
    const head = opts.prependEmbed ? ["", wikilinkEmbed(opts.prependEmbed)] : [];
    const at = opts.anchorLine != null ? opts.anchorLine + 1 : lines.length;
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
