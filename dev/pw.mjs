// 開発用ツール（acceptance・playthrough）が使う Playwright。
// この repo の依存には入れていない。別の場所にある Playwright を使うときは環境変数で指す:
//   PLAYWRIGHT_PKG … Playwright を入れたプロジェクトの package.json のパス
//   PW_CHROME      … 使う Chromium の実行ファイル（省略すると Playwright の既定のブラウザ）
// npm run acceptance / npm run playthrough は .env.local があれば読む（.gitignore 済み）。
import { createRequire } from "node:module";

const require = createRequire(process.env.PLAYWRIGHT_PKG ?? import.meta.url);
let pw;
try {
  pw = require("playwright");
} catch (e) {
  throw new Error(`playwright が見つかりません。npm i -D playwright するか、PLAYWRIGHT_PKG で入っている場所を指してください（${e.message}）`);
}
export const { chromium } = pw;

/** chromium.launch に渡すオプション */
export const launchOptions = process.env.PW_CHROME ? { executablePath: process.env.PW_CHROME } : {};
