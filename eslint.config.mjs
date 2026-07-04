import obsidianmd from "eslint-plugin-obsidianmd";
import tseslint from "typescript-eslint";
import comments from "@eslint-community/eslint-plugin-eslint-comments";

// Obsidian がコミュニティプラグインのリリースに対して行う自動チェック
// （eslint-plugin-obsidianmd の "recommended"）をローカルで再現する。
// リリース前に必ず実行する:
//
//     npm run lint   （= npx eslint src）
//
// Obsidian の release dashboard はこのうち一部だけをブロッキング "error"
// として扱い（no-static-styles-assignment / no-manual-html-headings 等）、
// 残りは非ブロッキング "warning" として表示する。ここでも同様に設定し、
// 非ゼロ終了＝本当にブロッキングな問題が再混入した、という意味にする。
export default tseslint.config(
  ...obsidianmd.configs.recommended,
  {
    // Obsidian の release dashboard はブロッカー扱い: eslint-disable には必ず
    // `-- 理由` を付ける。ローカルでも error にして再現し、リリース後の Fail を防ぐ。
    plugins: { "@eslint-community/eslint-comments": comments },
    rules: {
      "@eslint-community/eslint-comments/require-description": "error",
    },
  },
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      // UI 文言は日本語なので英語のセンテンスケース規則は適用外。Obsidian の
      // release dashboard でも sentence-case は非ブロッキング（warning）扱い。
      "obsidianmd/ui/sentence-case": "warn",
      // --- typescript-eslint の型安全系: 助言的・非ブロッキング ---
      "@typescript-eslint/no-unsafe-member-access": "warn",
      "@typescript-eslint/no-unsafe-assignment": "warn",
      "@typescript-eslint/no-unsafe-call": "warn",
      "@typescript-eslint/no-unsafe-argument": "warn",
      "@typescript-eslint/no-unsafe-return": "warn",
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-floating-promises": "warn",
      "@typescript-eslint/no-misused-promises": "warn",
      "@typescript-eslint/no-unnecessary-type-assertion": "warn",
      "@typescript-eslint/no-redundant-type-constituents": "warn",
      "@typescript-eslint/prefer-promise-reject-errors": "warn",
      "@typescript-eslint/no-unused-vars": "warn",
    },
  },
  {
    ignores: ["main.js", "build/", "node_modules/"],
  },
);
