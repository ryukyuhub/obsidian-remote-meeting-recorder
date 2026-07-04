import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs";

const execFileAsync = promisify(execFile);

/**
 * whisper.cpp CLI で 16kHz mono WAV を文字起こしし、プレーンテキストを返す。
 * -nt でタイムスタンプ無し、-otxt/-of で <outBase>.txt に出力し読み取る。
 */
export async function transcribeWav(
  bin: string,
  model: string,
  wavPath: string,
  language: string,
  outBase: string
): Promise<string> {
  const args = [
    "-m", model,
    "-f", wavPath,
    "-l", language || "auto",
    "-nt", // タイムスタンプ無し
    "-np", // システムログを抑制
    "-otxt",
    "-of", outBase,
  ];
  await execFileAsync(bin, args, { timeout: 3_600_000, maxBuffer: 1 << 26 });
  const txtPath = `${outBase}.txt`;
  let text = "";
  try {
    text = fs.readFileSync(txtPath, "utf8");
  } finally {
    try {
      fs.unlinkSync(txtPath);
    } catch {
      // 無視
    }
  }
  return text.trim();
}
