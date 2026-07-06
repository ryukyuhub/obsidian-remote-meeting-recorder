import { TFile } from "obsidian";

/**
 * 右クリック文字起こしの対象とする音声/動画コンテナの拡張子。
 * デコードはレンダラの Web Audio（Chromium）に任せるため（設計書 §15・pcm.ts）、
 * ffmpeg 等の同梱は不要。Chromium が扱えない形式は decodeToPcm16k が明示エラーにする。
 */
export const AUDIO_EXTS = [
  "m4a",
  "mp3",
  "wav",
  "aac",
  "flac",
  "ogg",
  "opus",
  "webm",
  "mp4",
  "mov",
  "m4b",
  "3gp",
];

/** TFile が文字起こし対象の音声かどうか。 */
export function isAudioFile(file: TFile): boolean {
  return AUDIO_EXTS.includes(file.extension.toLowerCase());
}
