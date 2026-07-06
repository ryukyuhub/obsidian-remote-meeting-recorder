/* PCM ユーティリティ（設計書 §15.1・§15.3）。
 * アーカイブ m4a（高品質）と文字起こし用 16kHz mono PCM を分離する。
 * デコード/リサンプルはレンダラの Web Audio（sysrec 無改修）。 */

/** m4a/AAC のバイト列を 16kHz mono Float32 PCM にデコード＋リサンプル。 */
export async function decodeToPcm16k(bytes: ArrayBuffer): Promise<Float32Array> {
  const targetRate = 16000;

  // 1) 任意サンプルレート/チャンネルでデコード
  const decodeCtx = new AudioContext();
  let audioBuf: AudioBuffer;
  try {
    // decodeAudioData は ArrayBuffer を detach するので複製を渡す
    audioBuf = await decodeCtx.decodeAudioData(bytes.slice(0));
  } catch {
    // Chromium が対応しない形式・破損ファイル等。無言失敗にせず対処が分かるエラーにする（§4.2）。
    throw new Error(
      "この音声ファイルを読み込めませんでした。対応形式は m4a / mp3 / wav / aac / flac / ogg / mp4 などです。ファイルが壊れていないか確認してください。"
    );
  } finally {
    void decodeCtx.close();
  }

  // 2) OfflineAudioContext(1ch, 16kHz) でモノラル化＋リサンプル
  const frames = Math.max(1, Math.ceil(audioBuf.duration * targetRate));
  const offline = new OfflineAudioContext(1, frames, targetRate);
  const src = offline.createBufferSource();
  src.buffer = audioBuf; // stereo→mono は speakers ダウンミックスで平均化
  src.connect(offline.destination);
  src.start();
  const rendered = await offline.startRendering();
  return rendered.getChannelData(0).slice();
}

/** 16kHz mono Float32 → 16bit PCM WAV バイト列（whisper-cli に渡す入力）。 */
export function pcmToWav(f32: Float32Array, sampleRate = 16000): ArrayBuffer {
  const numSamples = f32.length;
  const buffer = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(buffer);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + numSamples * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true); // PCM チャンクサイズ
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits/sample
  writeStr(36, "data");
  view.setUint32(40, numSamples * 2, true);
  let off = 44;
  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    off += 2;
  }
  return buffer;
}
