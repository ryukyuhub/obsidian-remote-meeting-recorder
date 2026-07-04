import { requestUrl } from "obsidian";

/* AI 要約（設計書 §15.3・既定 Anthropic）。
 * サーバ非依存にするため Anthropic Messages API を Obsidian の requestUrl で直接叩く
 * （requestUrl はメインプロセス経由で CORS を回避）。openai/ollama はサーバ /summarize 側で対応。 */

export interface SummarizeConfig {
  provider: string;
  apiKey: string;
  model: string;
  language: string;
}

function buildPrompt(transcript: string, language: string): string {
  const lang = language && language !== "auto" ? language : "日本語";
  return (
    `以下は会議の文字起こしです。${lang}で、Markdown の見出し付きで簡潔にまとめてください。\n` +
    `構成:\n### 要約\n（3〜6行）\n### アクションアイテム\n（- [ ] 形式・担当や期限があれば併記）\n` +
    `### 決定事項\n（- 箇条書き）\n無い項目は省略してかまいません。\n\n---\n` +
    transcript
  );
}

/** Anthropic Messages API で要約 Markdown を生成（既定モデル claude-opus-4-8）。 */
export async function summarizeWithAnthropic(
  transcript: string,
  cfg: SummarizeConfig
): Promise<string> {
  if (!cfg.apiKey) throw new Error("Anthropic API キーが未設定です");
  const body = {
    model: cfg.model || "claude-opus-4-8",
    max_tokens: 2048,
    messages: [{ role: "user", content: buildPrompt(transcript, cfg.language) }],
  };
  const r = await requestUrl({
    url: "https://api.anthropic.com/v1/messages",
    method: "POST",
    headers: {
      "x-api-key": cfg.apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    throw: false,
  });
  if (r.status < 200 || r.status >= 300) {
    throw new Error(`Anthropic HTTP ${r.status}: ${(r.text ?? "").slice(0, 200)}`);
  }
  const json = r.json as { content?: Array<{ type: string; text?: string }> };
  const text = (json.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("")
    .trim();
  if (!text) throw new Error("要約が空でした");
  return text;
}
