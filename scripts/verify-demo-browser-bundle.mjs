/**
 * demo バンドルの browser 適合性を機械検証する（m3-t1 設計 v1.3 §6.3(b) / m3-t1/AC-4）。
 *
 * これは **C11（Daedalus の browser 動作）解消のうち「バンドル可能性」行**の裏づけである。
 * **`browser runtime での実行` 行の裏づけにはならない**（そちらは m3-t1/AC-16 の 1 回観測）。
 * 2 つの行を混ぜないことは設計 §3.4 / K1 / K19 の規律である。
 *
 * `Atlas/scripts/verify-packed-browser-runtime.mjs` の**軽量版**である（設計 §7 の
 * 「逸脱（軽量化）」）: Teiresias は `HR-m3-005` により publish しない ∴ `npm pack` 経路を
 * 通す意味が無く、demo build の出力チャンクを走査する形へ縮めた。
 *
 * 検査は 4 つ:
 *   (1) `dist-demo/` が無ければ「先に build:demo を実行せよ」と言って exit 1（黙って成功しない）
 *   (2) アプリチャンクに Node 固有指定子が残っていない
 *   (3) 検査が実際に発火することを合成文字列で自己検証する（vacuous に緑にならない）
 *   (4) Daedalus 由来のコードがバンドルに**実在する**（「入っていないのに緑」を防ぐ）
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const distDemo = fileURLToPath(new URL("../dist-demo/", import.meta.url));
const assetsDir = join(distDemo, "assets");

/** proj-wasm の runtime asset（vite が出力したチャンクではない）∴ 走査対象から外す。 */
const PROJ_WASM_RUNTIME_ASSETS = new Set([
  "proj.db",
  "proj.ini",
  "proj-worker.mjs",
  "fetch-worker.mjs",
  "proj-emscripten.js",
  "proj-emscripten.wasm",
]);

/** Node 固有指定子の needle（設計 §6.3(b) 手順 3）。 */
const NODE_NEEDLES = [
  "node:",
  "require(",
  "__dirname",
  "__filename",
  "process.env",
  'from "fs"',
  'from "path"',
];

/**
 * **明示的に許容する 1 件**（enumerated ratchet。allowlist ではなく「全数の説明」である）。
 *
 * `@c4h/atlas` の `src/proj-wasm-crs.ts:361-362` は custom projection の読み出しで
 * `const nodeFsPromises = "node:fs/promises"; await import(/* @vite-ignore *\/ nodeFsPromises)`
 * という**遅延 import** を持つ。指定子は変数に隠されており bundler は解決しない。実行に
 * 到達するのは Node 分岐だけであり、browser 分岐は `fetch` を使う ∴ **browser runtime の
 * 危険ではない**。しかし needle `node:` は文字列 literal に当たる。
 *
 * ∴ 検査を緩めずに、**「残る `node:` 出現は、この literal に由来するものが全部である」**
 * ことを要求する。新しい `node:` が 1 つでも増えれば FAIL する（ラチェット）。
 * **実装元（Atlas）は本タスクの触り先ではない**ため、実装元側で規律を強制する道は取れない
 * （`H-9` の正しい形が取れない唯一のケース。理由をここに残す）。
 */
const DEFERRED_NODE_SPECIFIER_LITERAL = '"node:fs/promises"';
const DEFERRED_NODE_SPECIFIER_MAX = 1;

function countOccurrences(haystack, needle) {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

function fail(message) {
  console.error(`verify-demo-browser-bundle.mjs: ${message}`);
  process.exitCode = 1;
}

// (1) 前提 ------------------------------------------------------------------
if (!existsSync(distDemo) || !existsSync(assetsDir)) {
  console.error(
    "verify-demo-browser-bundle.mjs: dist-demo/assets が無い。先に `pnpm run build:demo` を実行せよ。",
  );
  process.exit(1);
}

const chunkFiles = readdirSync(assetsDir)
  .filter((name) => name.endsWith(".js"))
  .filter((name) => !PROJ_WASM_RUNTIME_ASSETS.has(basename(name)))
  .sort();

if (chunkFiles.length === 0) {
  console.error("verify-demo-browser-bundle.mjs: 走査対象のアプリチャンクが 0 件である（検査が vacuous になる）。");
  process.exit(1);
}

// (2) Node 固有指定子 --------------------------------------------------------
let violations = 0;
let deferredTotal = 0;

for (const name of chunkFiles) {
  const text = readFileSync(join(assetsDir, name), "utf8");
  const deferredHere = countOccurrences(text, DEFERRED_NODE_SPECIFIER_LITERAL);
  deferredTotal += deferredHere;

  for (const needle of NODE_NEEDLES) {
    const hits = countOccurrences(text, needle);
    const allowed = needle === "node:" ? deferredHere : 0;
    if (hits > allowed) {
      violations += 1;
      fail(`${name}: Node 固有指定子 ${JSON.stringify(needle)} が ${hits} 件（許容 ${allowed} 件）`);
    }
  }
}

if (deferredTotal > DEFERRED_NODE_SPECIFIER_MAX) {
  violations += 1;
  fail(
    `遅延 import の literal ${DEFERRED_NODE_SPECIFIER_LITERAL} が ${deferredTotal} 件ある` +
      `（既知は ${DEFERRED_NODE_SPECIFIER_MAX} 件 = @c4h/atlas の custom projection 読み出し）。増えた分を説明せよ。`,
  );
}

// (3) 自己検証（検査が実際に発火することを合成文字列で確かめる） --------------
const SYNTHETIC = 'import x from "node:fs";\nconst y = require("child_process");\nconsole.log(__dirname, process.env.HOME);';
const detected = NODE_NEEDLES.filter((needle) => SYNTHETIC.includes(needle));
const expectedDetected = ["node:", "require(", "__dirname", "process.env"];
if (JSON.stringify(detected) !== JSON.stringify(expectedDetected)) {
  violations += 1;
  fail(
    `自己検証に失敗した。合成文字列に対する検出結果が ${JSON.stringify(detected)} で、` +
      `期待 ${JSON.stringify(expectedDetected)} と違う（needle 定義が壊れている）。`,
  );
}

// (4) Daedalus 由来コードの存在確認 -----------------------------------------
// needle は `fitWorldFile`（関数名 ∴ minify で消えうる）ではなく、Daedalus 固有の
// WarningCode 文字列 literal を使う（minify されても文字列 literal は残る）。
const DAEDALUS_MARKER = "affineSkippedCollinear";
const daedalusChunks = chunkFiles.filter((name) =>
  readFileSync(join(assetsDir, name), "utf8").includes(DAEDALUS_MARKER),
);
if (daedalusChunks.length === 0) {
  violations += 1;
  fail(
    `Daedalus 由来コードの目印 ${JSON.stringify(DAEDALUS_MARKER)} がどのチャンクにも無い。` +
      "バンドルに Daedalus が入っていない ∴ この検査は C11 の裏づけにならない。",
  );
}

// (5) アプリ本体チャンクが Node 組込みの browser 外部化スタブを引いていないこと ----
// vite は解決できない Node 組込みを `__vite-browser-external` へ**黙って**差し替える ∴
// 本体チャンクがそれを import していたら、Node 依存が隠れたまま緑になりうる。
for (const name of daedalusChunks) {
  const text = readFileSync(join(assetsDir, name), "utf8");
  if (text.includes("__vite-browser-external")) {
    violations += 1;
    fail(`${name}: Daedalus/Teiresias 本体チャンクが __vite-browser-external を参照している`);
  }
}

if (violations > 0) {
  console.error(`verify-demo-browser-bundle.mjs: ${violations} 件の違反`);
  process.exit(1);
}

console.log(
  `demo browser bundle verified. chunks=${chunkFiles.length} ` +
    `daedalus=${daedalusChunks.join(",")} deferred-node-literal=${deferredTotal}`,
);
