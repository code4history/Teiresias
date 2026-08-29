/**
 * デモ専用の vite 設定（m3-t1 設計 v1.3 §6.2）。
 *
 * `Atlas/vite.config.ts` の適応であり、**差分だけ**を持つ（前例踏襲様式）:
 *
 * - **demo build のみ**。Teiresias の package build は `tsc`（`package.json` の `build`）で
 *   あり、vite は demo 専用である ∴ Atlas の `BUILD_MODE=package` 分岐を持たない。
 * - `base` は `/Teiresias/`（Pages の repo 名）。
 * - `rollupOptions.input` は portal と `demo/crs-estimate-ranking.html` の 2 枚。
 * - proj-wasm の asset base URL のグローバル名は **`__TEIRESIAS_PROJ_WASM_ASSET_BASE_URL__`**
 *   （設計 K9。Atlas の `__ATLAS_…` と名前空間を分ける — 将来同一ページで両方を読み込んだ
 *   場合に衝突しないため）。
 * - `test` セクションは**置かない**（`vitest.config.ts` が既存 ∴ 二重定義を避ける）。
 * - COOP / COEP / `coi-serviceworker` は**入れない**（Atlas の規約を踏襲。緩めない）。
 * - `data/crs/custom-projections.json` は複製しない（本デモは custom projection を使わない）。
 */
import { defineConfig } from "vite";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, extname, join, resolve } from "node:path";
import process from "node:process";

const isPagesBuild = process.env.GITHUB_PAGES === "true";
const require = createRequire(import.meta.url);
const projWasmDist = dirname(require.resolve("proj-wasm"));

export const PROJ_WASM_RUNTIME_ASSETS = [
  "proj.db",
  "proj.ini",
  "proj-worker.mjs",
  "fetch-worker.mjs",
  "proj-emscripten.js",
  "proj-emscripten.wasm",
];

const contentTypeForAsset = (asset: string) => {
  switch (extname(asset)) {
    case ".mjs":
    case ".js":
      return "application/javascript; charset=utf-8";
    case ".wasm":
      return "application/wasm";
    case ".db":
      return "application/octet-stream";
    case ".ini":
      return "text/plain; charset=utf-8";
    default:
      return "application/octet-stream";
  }
};

const copyRuntimeAssets = () => ({
  name: "copy-runtime-assets",
  apply: "build" as const,
  async closeBundle() {
    const outputDir = resolve(__dirname, "dist-demo/assets");
    await mkdir(outputDir, { recursive: true });
    await Promise.all(
      PROJ_WASM_RUNTIME_ASSETS.map((asset) =>
        copyFile(join(projWasmDist, asset), join(outputDir, asset)),
      ),
    );
  },
});

const serveProjWasmDemoAssets = () => ({
  name: "serve-proj-wasm-demo-assets",
  async configureServer(server: { middlewares: { use: (handler: (req: { url?: string }, res: { setHeader: (name: string, value: string) => void; end: (body: Buffer) => void }, next: () => void) => void) => void } }) {
    const assetBodies = new Map<string, Buffer>();
    await Promise.all(
      PROJ_WASM_RUNTIME_ASSETS.map(async (asset) => {
        assetBodies.set(asset, await readFile(join(projWasmDist, asset)));
      }),
    );

    server.middlewares.use((req, res, next) => {
      const requestPath = req.url?.split("?")[0] ?? "";
      const assetName = basename(requestPath);
      const body = assetBodies.get(assetName);
      if (!body) {
        next();
        return;
      }

      res.setHeader("Content-Type", contentTypeForAsset(assetName));
      res.end(body);
    });
  },
});

const PROJ_WASM_BROWSER_ID = `${join(projWasmDist, "proj.mjs")}?teiresias-browser`;

const aliasProjWasmBrowserRuntime = () => ({
  name: "alias-proj-wasm-browser-runtime",
  enforce: "pre" as const,
  resolveId(source: string) {
    if (source === "proj-wasm") {
      return PROJ_WASM_BROWSER_ID;
    }
    return null;
  },
  async load(id: string) {
    if (id !== PROJ_WASM_BROWSER_ID) {
      return null;
    }

    let code = await readFile(join(projWasmDist, "proj.mjs"), "utf8");
    code = code.replace(
      'const baseUrl = new URL("./", import.meta.url).href;',
      'const baseUrl = globalThis.__TEIRESIAS_PROJ_WASM_ASSET_BASE_URL__ ?? new URL("./", import.meta.url).href;',
    );
    code = code.replace(
      'const workerUrl = new URL("./proj-worker.mjs", import.meta.url);',
      'const workerUrl = new URL("proj-worker.mjs", globalThis.__TEIRESIAS_PROJ_WASM_ASSET_BASE_URL__ ?? new URL("./", import.meta.url).href);',
    );
    return code;
  },
});

export default defineConfig({
  base: isPagesBuild ? "/Teiresias/" : "/",
  build: {
    outDir: "dist-demo",
    copyPublicDir: false,
    rollupOptions: {
      input: {
        index: resolve(__dirname, "index.html"),
        crsEstimateRanking: resolve(__dirname, "demo/crs-estimate-ranking.html"),
      },
    },
  },
  plugins: [aliasProjWasmBrowserRuntime(), copyRuntimeAssets(), serveProjWasmDemoAssets()],
  optimizeDeps: {
    exclude: ["proj-wasm"],
  },
});
