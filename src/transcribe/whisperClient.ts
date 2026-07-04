import { requestUrl } from "obsidian";

/* ローカル Whisper サーバ（MLX）の薄い HTTP クライアント（設計書 §15.3）。
 * 契約は iahmedani/voice-notes-server 準拠。requestUrl で CORS を回避。 */

export interface HealthResult {
  status: string;
  model?: string;
  device?: string;
  diarization?: boolean;
  features?: string[];
}

export interface TranscribeResult {
  text: string;
  segments?: Array<{ start: number; end: number; text: string }>;
  detected_language?: string;
  duration?: number;
}

export interface SummarizeResult {
  summary: string;
}

export interface ActionsResult {
  action_items?: Array<{ task?: string; owner?: string; due?: string; priority?: string }>;
  decisions?: string[];
  follow_ups?: string[];
}

export interface AiCreds {
  provider: string;
  apiKey: string;
  model?: string;
}

export class WhisperClient {
  constructor(private baseUrl: string) {}

  private url(p: string): string {
    return this.baseUrl.replace(/\/+$/, "") + p;
  }

  private async postJson(path: string, body: unknown): Promise<unknown> {
    const r = await requestUrl({
      url: this.url(path),
      method: "POST",
      contentType: "application/json",
      body: JSON.stringify(body),
      throw: false,
    });
    if (r.status < 200 || r.status >= 300) {
      throw new Error(`HTTP ${r.status}: ${(r.text ?? "").slice(0, 200)}`);
    }
    return r.json;
  }

  /** 疎通確認（失敗は null）。 */
  async health(): Promise<HealthResult | null> {
    try {
      const r = await requestUrl({ url: this.url("/health"), method: "GET", throw: false });
      if (r.status !== 200) return null;
      return r.json as HealthResult;
    } catch {
      return null;
    }
  }

  /** 一括文字起こし（is_chunk:false）。pcmB64 は 16kHz mono Float32 の base64。 */
  async transcribe(
    pcmB64: string,
    opts: { language?: string; model?: string; diarize?: boolean }
  ): Promise<TranscribeResult> {
    const body: Record<string, unknown> = {
      audio_pcm_base64: pcmB64,
      format: "float32",
      sample_rate: 16000,
      language: opts.language || "auto",
      is_chunk: false,
      diarize: opts.diarize ?? false,
    };
    if (opts.model) body.model = opts.model;
    return (await this.postJson("/transcribe", body)) as TranscribeResult;
  }

  /** AI 要約（キーはクライアントが渡す＝サーバは保持しない）。 */
  async summarize(transcript: string, ai: AiCreds): Promise<SummarizeResult> {
    const body: Record<string, unknown> = {
      transcript,
      provider: ai.provider,
      api_key: ai.apiKey,
    };
    if (ai.model) body.model = ai.model;
    return (await this.postJson("/summarize", body)) as SummarizeResult;
  }

  /** アクションアイテム/決定事項/フォローアップ抽出。 */
  async extractActions(transcript: string, ai: AiCreds): Promise<ActionsResult> {
    const body: Record<string, unknown> = {
      transcript,
      provider: ai.provider,
      api_key: ai.apiKey,
    };
    if (ai.model) body.model = ai.model;
    return (await this.postJson("/extract-actions", body)) as ActionsResult;
  }
}
