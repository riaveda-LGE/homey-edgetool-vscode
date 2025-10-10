// @ts-check
import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import simpleImportSort from "eslint-plugin-simple-import-sort";
import tseslint from "typescript-eslint";

/** @type {import("eslint").Linter.Config[]} */
export default [
  // ✅ 전역 무시 규칙은 맨 위에
  {
    ignores: ["dist/**", "legacy/**", "node_modules/**"],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  // 📦 import 정렬 + prettier
  {
    plugins: {
      "simple-import-sort": simpleImportSort,
    },
    rules: {
      "simple-import-sort/imports": "warn",
      "simple-import-sort/exports": "warn",
      "@typescript-eslint/no-explicit-any": "off", // 필요하면 끄기
      "no-empty": "off",
      "@typescript-eslint/no-empty-function": "off",
      "@typescript-eslint/no-unused-vars": "off",
    },
  },

  // 🌐 Webview JS (panel.js)
  {
    files: ["media/**/*.js"],
    languageOptions: {
      globals: {
        window: "readonly",
        document: "readonly",
        acquireVsCodeApi: "readonly",
        setTimeout: "readonly",
      },
    },
  },

  // 🖥 Node.js 스크립트 (deploy.js)
  {
    files: ["scripts/**/*.js"],
    languageOptions: {
      globals: {
        require: "readonly",
        module: "readonly",
        process: "readonly",
        console: "readonly",
      },
    },
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },

  prettier,
];
