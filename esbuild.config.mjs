import esbuild from "esbuild";
import process from "process";
import fs from "fs";
import path from "path";
import builtins from "builtin-modules";

const banner = `/*
このファイルは esbuild が生成・バンドルしたものです。
ソースは src/ 以下を参照してください。
*/
`;

const prod = process.argv[2] === "production";

// 出力先。既定はリポジトリ直下（テスト Vault へのシンボリックリンク運用のため）。
// CI のリリースでは OUT_DIR=./build を指定して 3 点セットをそこへ集める。
const OUT_DIR = process.env.OUT_DIR || ".";
fs.mkdirSync(OUT_DIR, { recursive: true });

// manifest.json / styles.css を出力先へコピー（出力先が root と同じなら自己コピーは省略）。
const ASSETS = ["manifest.json", "styles.css"];
const copyAssetsPlugin = {
  name: "copy-assets",
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length > 0) return;
      if (path.resolve(OUT_DIR) === path.resolve(".")) return;
      for (const name of ASSETS) {
        fs.copyFileSync(name, path.join(OUT_DIR, name));
      }
    });
  },
};

const context = await esbuild.context({
  banner: { js: banner },
  entryPoints: ["main.ts"],
  bundle: true,
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    // Node ビルトイン（デスクトップレンダラで実行時解決）
    ...builtins,
  ],
  format: "cjs",
  target: "es2022",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: path.join(OUT_DIR, "main.js"),
  minify: prod,
  platform: "node",
  plugins: [copyAssetsPlugin],
});

if (prod) {
  await context.rebuild();
  await context.dispose();
  process.exit(0);
} else {
  await context.watch();
}
