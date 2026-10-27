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
 * - cross-origin isolation のヘッダ 2 種と、それを注入する service worker は**入れない**
 *   （Atlas の規約を踏襲。緩めない）。禁止語の literal を本ファイルへ書かないのは、
 *   `tests/publish-and-demo.test.ts` の否定 assert が**この注記自身を検出して常に RED に
 *   なる**のを避けるためである（needle の正本は同テストの表側にある）。
 * - `data/crs/custom-projections.json` は複製しない（本デモは custom projection を使わない）。
 */
import { defineConfig } from "vite";
import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, extname, join, resolve } from "node:path";
import process from "node:process";

const isPagesBuild = process.env.GITHUB_PAGES === "true";
const require = createRequire(import.meta.url);
const projWasmDist = dirname(require.resolve("proj-wasm"));

/**
 * 3 つの package の版（フッタの「使っている版」に出す）。
 *
 * package.json は `dist-demo` に入らない ∴ 実行時に読むのではなく、build のときに焼き込む
 * （`define` の `__C4H_VERSIONS__`）。`pnpm run dev` も同じ設定を通る ∴ dev と Pages で
 * 同じ値が出る。
 */
function manifestVersion(packageRoot: string): string {
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
    version: string;
  };
  return manifest.version;
}

/**
 * 依存 package の root。`require.resolve` は export の条件（import のみ）で解けないことがある ∴
 * `node_modules` の下を直接見る（link はそのまま辿る）。
 */
function installedPackageRoot(name: string): string {
  const directory = resolve(__dirname, "node_modules", name);
  if (!existsSync(join(directory, "package.json"))) {
    throw new Error(`cannot find the package.json of ${name} (install it first)`);
  }
  return directory;
}

const C4H_VERSIONS = {
  atlas: manifestVersion(installedPackageRoot("@c4h/atlas")),
  daedalus: manifestVersion(installedPackageRoot("@c4h/daedalus")),
  teiresias: manifestVersion(__dirname),
};

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
  // フッタの「使っている版」。build と dev server の両方がこの設定を通る。
  define: {
    __C4H_VERSIONS__: JSON.stringify(C4H_VERSIONS),
  },
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
