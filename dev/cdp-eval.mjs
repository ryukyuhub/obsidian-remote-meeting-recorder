// Obsidian を CDP（Chrome DevTools Protocol）経由で操作する E2E 用ヘルパー。
//
// 前提: Obsidian を `--remote-debugging-port=9222` 付きで起動しておく（テスト時のみ。
// ローカルの任意プロセスから操作できる状態になるため、テスト後は通常起動に戻すこと）。
//
//   Obsidian.exe --remote-debugging-port=9222 "obsidian://open?vault=<vault>"
//
// 使い方: node dev/cdp-eval.mjs <expression-file>
//   <expression-file> に書いた JS 式を Obsidian レンダラで評価し、結果を JSON で stdout に出す。
//   Node 22+（ネイティブ WebSocket）。WSL からは Windows 側 node で実行する。
//
// 式の例（レンダラ内で使える）:
//   app.commands.executeCommandById("remote-meeting-recorder:stop-recording")
//   app.plugins.plugins["remote-meeting-recorder"].startRecordingFromView({...})
//     ※ start-recording コマンドは「録音ビューを開く」だけなので、録音の実開始は
//        ビューの値を渡して startRecordingFromView を直接呼ぶ（test/manual-e2e/README.md 参照）。
import { readFileSync } from "node:fs";

const expr = readFileSync(process.argv[2], "utf8");
const list = await (await fetch("http://127.0.0.1:9222/json/list")).json();
const page = list.find((t) => t.type === "page" && !t.url.startsWith("devtools"));
if (!page) {
  console.log(JSON.stringify({ error: "page target not found", targets: list.map((t) => t.url) }));
  process.exit(1);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = () => rej(new Error("websocket error"));
});
const result = await new Promise((res, rej) => {
  const timer = setTimeout(() => rej(new Error("timeout")), 30000);
  ws.onmessage = (ev) => {
    const m = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString());
    if (m.id === 1) {
      clearTimeout(timer);
      res(m.result);
    }
  };
  ws.send(
    JSON.stringify({
      id: 1,
      method: "Runtime.evaluate",
      params: { expression: expr, awaitPromise: true, returnByValue: true },
    })
  );
});
console.log(JSON.stringify(result));
ws.close();
