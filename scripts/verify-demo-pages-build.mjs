/**
 * Pages 成果物の形を検証する（m3-t1 設計 v1.3 §6.3(a) / m3-t1/AC-3）。
 *
 * `Atlas/scripts/verify-demo-pages-build.mjs` の適応であり、差分は次の 2 点だけである:
 *   - 必須ファイルのデモページ名（`demo/crs-estimate-ranking.html`）
 *   - base path 検査（`/Teiresias/assets/`）
 * リダイレクトスタブ禁止 / `coi-serviceworker` 禁止 / COOP・COEP 禁止 /
 * origin-rooted `/assets/` 禁止 / `proj.db` 最小サイズは **すべて同一**である
 * （C4H の規約であり、Teiresias 側で緩めない）。
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { relative } from "node:path";

const root = new URL("../dist-demo/", import.meta.url);
const requiredFiles = [
  "index.html",
  "demo/crs-estimate-ranking.html",
  "assets/proj.db",
  "assets/proj.ini",
  "assets/proj-worker.mjs",
  "assets/fetch-worker.mjs",
  "assets/proj-emscripten.js",
  "assets/proj-emscripten.wasm",
];

async function readText(path) {
  return readFile(new URL(path, root), "utf8");
}

async function assertFile(path) {
  const info = await stat(new URL(path, root));
  if (!info.isFile()) {
    throw new Error(`${path} is not a file`);
  }
  return info;
}

async function listFiles(dirUrl = root) {
  const entries = await readdir(dirUrl, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const url = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, dirUrl);
    if (entry.isDirectory()) {
      files.push(...await listFiles(url));
    } else {
      files.push(relative(root.pathname, url.pathname));
    }
  }
  return files;
}

for (const file of requiredFiles) {
  await assertFile(file);
}

const projDb = await assertFile("assets/proj.db");
if (projDb.size < 1_000_000) {
  throw new Error(`assets/proj.db is unexpectedly small (${projDb.size} bytes)`);
}

const portalHtml = await readText("index.html");
const demoHtml = await readText("demo/crs-estimate-ranking.html");
if (/http-equiv=["']refresh/i.test(portalHtml) || /http-equiv=["']refresh/i.test(demoHtml)) {
  throw new Error("demo pages must not be redirect stubs");
}
if (!portalHtml.includes("/Teiresias/assets/") || !demoHtml.includes("/Teiresias/assets/")) {
  throw new Error("built HTML does not resolve bundled modules under /Teiresias/assets/");
}

const textFiles = (await listFiles()).filter((file) => /\.(?:html|js|mjs|css)$/.test(file));
for (const file of textFiles) {
  const text = await readText(file);
  if (text.includes("coi-serviceworker")) {
    throw new Error(`${file} references coi-serviceworker`);
  }
  if (text.includes("Cross-Origin-Opener-Policy") || text.includes("Cross-Origin-Embedder-Policy")) {
    throw new Error(`${file} injects COOP/COEP headers`);
  }
  if (/["'`](?:\/assets\/)/.test(text)) {
    throw new Error(`${file} contains an origin-rooted /assets/ URL`);
  }
}

console.log("dist-demo Pages artifact verified.");
