/**
 * デモ配備の静的検査（m3-t1 設計 v1.3 §6.7(a) / m3-t1/AC-7 / m3-t1/AC-12）。
 *
 * `Atlas/tests/publish-and-demo.test.ts`（125 行 / 8 個の `it`）の**適応**である。
 * 適応差分の正本は設計 §6.7(a) の表であり、要点だけ再掲する:
 *
 * - Atlas の `it` #1（npm metadata / publish scripts）と #2（bilingual README）は**落とす**
 *   （前者のキーは m3-t2 の所有 ∴ m3-t1 時点では必ず RED になる。`prepublishOnly` は
 *   `HR-m3-005`〔publish なし〕により恒久的に存在しない。後者は `README.ja.md` が無い）。
 *   `scripts` / `devDependencies` の assert は `package-shape.test.ts` が持つ ∴ 二重定義しない。
 * - Atlas の #4 は対象ファイルを `demo/atlas-engine.js` へ差し替える（§5.4 のモジュール分割）。
 * - `benchmark.html` / `option value="japan" selected` の否定 assert は Atlas 固有 ∴ 落とす。
 * - `packedScript`（`verify-packed-browser-runtime.mjs`）の 4 行は落とし、
 *   `verify-demo-browser-bundle.mjs` を読む形へ置き換える（`npm pack` 経路を持たないため）。
 *
 * **新規 2 項目**（Atlas に対応物なし）:
 * - m3-t1/AC-7 の一部: `demo/*.js` に HTML sink が 0 件であること（K20）
 * - m3-t1/AC-12: ワークフローの静的検査（needle ↔ ファイル対応表は設計 §9.1a）
 *
 * ⚠️ **Atlas `deploy.yml` の `master` 化はここでは検査しない。**
 * 3 repo を分離した後に相対パス参照が解決不能になるため、Atlas 内で閉じる検査として
 * `Atlas/tests/publish-and-demo.test.ts` 側へ置いた（設計 §6.7(b) / K22）。
 */
import { access, readFile } from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const testsDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(testsDir, '..');
const daedalusRoot = join(packageRoot, '..', 'Daedalus');

const readText = (...segments: string[]): Promise<string> =>
  readFile(join(packageRoot, ...segments), 'utf8');

describe('publish and demo packaging', () => {
  it('includes GitHub Actions for CI and Pages deployment', async () => {
    await access(join(packageRoot, '.github', 'workflows', 'test.yml'));
    await access(join(packageRoot, '.github', 'workflows', 'deploy.yml'));
  });

  it('keeps demo shell independent from lookup runtime at module load', async () => {
    const engineJs = await readText('demo', 'atlas-engine.js');
    const mainJs = await readText('demo', 'main.js');

    expect(engineJs).toContain('import(\'@c4h/atlas\')');
    expect(engineJs).toContain('initializeProjWasmRuntime');
    expect(engineJs).toContain('listProjectedCrsFromProjWasm');
    expect(engineJs).toContain('transformLonLatArrayToProjected');
    expect(engineJs).toContain('projWasmAssetBaseUrl');
    expect(engineJs).toContain("new URL('assets/', pageRoot)");

    // §5.4 のモジュール分割が守られていること: DOM 結線層は engine を直接触らない。
    expect(mainJs).not.toContain('@c4h/atlas');
    expect(mainJs).toContain("from './atlas-engine.js'");
  });

  it('uses the C4H demo boilerplate shell', async () => {
    const portal = await readText('index.html');
    const demoPage = await readText('demo', 'crs-estimate-ranking.html');

    expect(portal).toContain('class="c4h-portal"');
    expect(portal).toContain('class="c4h-demo-card"');
    expect(portal).toContain('href="./demo/crs-estimate-ranking.html"');

    expect(demoPage).toContain('class="c4h-app"');
    expect(demoPage).toContain('class="c4h-back-link"');
    expect(demoPage).toContain('href="../index.html"');
    expect(demoPage).toContain('href="./demo-shell.css"');
    expect(demoPage).toContain('href="./style.css"');
    expect(demoPage).toContain('src="./main.js"');
    for (const id of [
      'y-flip',
      'candidate-mode',
      'reset-gcp',
      'geo-board',
      'geo-canvas',
      'pixel-board',
      'pixel-canvas',
      'ranked-body',
      'selected-body',
      'discrimination',
      'result-count',
      'untransformable',
      'status',
    ]) {
      expect(demoPage).toContain(`id="${id}"`);
    }
    expect(demoPage).toContain('c4h-header');
    expect(demoPage).toContain('c4h-panels');
    expect(demoPage).toContain('c4h-card');
    expect(demoPage).not.toContain('coi-serviceworker');
    expect(demoPage).not.toContain('Cross-Origin-Opener-Policy');
    expect(demoPage).not.toContain('Cross-Origin-Embedder-Policy');
  });

  it('adds no new c4h-* shell classes of its own (m3-t1/AC-7)', async () => {
    // シェルの規約は Atlas 所有 ∴ Teiresias は拡張しない（K17）。
    const style = await readText('demo', 'style.css');
    expect(style).not.toContain('c4h-');
    // デモ固有の見た目は接頭辞つきで置かれている（検査が vacuous でないことの確認）
    expect(style).toContain('.teiresias-');
  });

  it('never uses HTML string sinks in demo scripts (m3-t1/AC-7 / K20)', async () => {
    // outer の sink 走査（scripts/m1-t4/verify-html-sinks.mjs）は Teiresias を含まず、
    // 走査サブディレクトリにも demo が無い ∴ **二重に届かない**。走査で守れない分を
    // 構成で守る（設計 §5.4(2)）。ここが唯一の防壁である。
    const demoDir = join(packageRoot, 'demo');
    const scripts = readdirSync(demoDir).filter((name) => name.endsWith('.js')).sort();
    expect(scripts).toEqual(['atlas-engine.js', 'estimate-scene.js', 'main.js']);

    const sinks = ['innerHTML', 'outerHTML', 'insertAdjacentHTML'];
    const hits: string[] = [];
    for (const name of scripts) {
      const text = await readText('demo', name);
      for (const sink of sinks) {
        if (text.includes(sink)) hits.push(`${name}: ${sink}`);
      }
    }
    expect(hits).toEqual([]);

    // 0 件 assert が vacuous でないことの確認: DOM へ書く唯一のモジュール（main.js）が
    // **許可された経路を実際に使っている**こと。使っていなければ「そもそも DOM へ何も
    // 書いていない」だけであり、0 件は何も保証しない。
    const mainJs = await readText('demo', 'main.js');
    expect(mainJs).toContain('textContent');
    expect(mainJs).toContain('createElement');

    // 走査が実際に発火することの自己検証（合成文字列）
    expect(sinks.filter((sink) => 'node.innerHTML = x;'.includes(sink))).toEqual(['innerHTML']);
  });

  it('keeps demo build inputs limited to the portal and estimate subpage', async () => {
    const viteConfig = await readText('vite.config.ts');
    expect(viteConfig).toContain('index: resolve(__dirname, "index.html")');
    expect(viteConfig).toContain('crsEstimateRanking: resolve(__dirname, "demo/crs-estimate-ranking.html")');
    expect(viteConfig).not.toContain('demoIndex');
  });

  it('serves package-distributed runtime assets without isolation headers', async () => {
    const viteConfig = await readText('vite.config.ts');
    for (const asset of ['proj.db', 'proj.ini', 'proj-worker.mjs', 'proj-emscripten.js', 'proj-emscripten.wasm']) {
      expect(viteConfig).toContain(`"${asset}"`);
    }
    expect(viteConfig).toContain('copy-runtime-assets');
    expect(viteConfig).toContain('serve-proj-wasm-demo-assets');
    expect(viteConfig).toContain('alias-proj-wasm-browser-runtime');
    expect(viteConfig).toContain('PROJ_WASM_BROWSER_ID');
    // K9: Atlas と名前空間を分ける
    expect(viteConfig).toContain('__TEIRESIAS_PROJ_WASM_ASSET_BASE_URL__');
    expect(viteConfig).not.toContain('__ATLAS_PROJ_WASM_ASSET_BASE_URL__');
    // 規約 ∴ 緩めない（Atlas から 1 文字も変えていない 3 本）
    expect(viteConfig).not.toContain('Cross-Origin-Opener-Policy');
    expect(viteConfig).not.toContain('Cross-Origin-Embedder-Policy');
    expect(viteConfig).not.toContain('coi-serviceworker');
  });

  it('has artifact-level Pages verification', async () => {
    const script = await readText('scripts', 'verify-demo-pages-build.mjs');
    const bundleScript = await readText('scripts', 'verify-demo-browser-bundle.mjs');
    const ci = await readText('.github', 'workflows', 'test.yml');
    const deploy = await readText('.github', 'workflows', 'deploy.yml');

    expect(script).toContain('assets/proj.db');
    expect(script).toContain('/Teiresias/assets/');
    expect(script).toContain('origin-rooted /assets/');
    expect(script).toContain('unexpectedly small');

    // Atlas の packedScript 4 行の置き換え（npm pack 経路を持たないため。設計 §6.7(a) #8）
    expect(bundleScript).toContain('affineSkippedCollinear');
    expect(bundleScript).toContain('自己検証');
    expect(bundleScript).toContain('__vite-browser-external');

    expect(ci).toContain('pnpm run verify:demo');
    expect(ci).toContain('pnpm run verify:demo-bundle');
    expect(deploy).toContain('pnpm run verify:demo');
    expect(deploy).toContain('pnpm run verify:demo-bundle');
  });
});

/**
 * m3-t1/AC-12: ワークフローの静的検査。
 *
 * **needle ↔ ファイル対応表の正本は設計 §9.1a である。** 検査はすべて
 * 「ファイルを文字列として読み `toContain` / `not.toContain` する」形に限る
 * （Node に YAML パーサは無く、`js-yaml` を入れない方針である）。
 *
 * ⚠️ `outer rule-0014`: リポジトリが GitHub 上に存在しない ∴ **これは CI の検証ではない。**
 * 「静的に妥当な yml を置いた」までしか主張しない。初回実行の観測は m3-t2 の責務である。
 */
describe('m3-t1/AC-12: ワークフローの静的検査（CI の検証ではない）', () => {
  it('Teiresias deploy.yml が master 起動・兄弟 checkout・Pages 配備を満たす', async () => {
    const deploy = await readText('.github', 'workflows', 'deploy.yml');
    for (const needle of [
      '- master',
      'path: Teiresias',
      'repository: code4history/Daedalus',
      'repository: code4history/Atlas',
      'ref: master',
      'working-directory: Teiresias',
      'cache-dependency-path',
      'Teiresias/pnpm-lock.yaml',
      'Atlas/pnpm-lock.yaml',
      'Daedalus/pnpm-lock.yaml',
      'pnpm run verify:demo',
      'pnpm run verify:demo-bundle',
      'path: ./Teiresias/dist-demo',
      'actions/configure-pages@v5',
      'actions/upload-pages-artifact@v3',
      'actions/deploy-pages@v4',
    ]) {
      expect(deploy).toContain(needle);
    }
    // 起動ブランチの取り違え検出
    expect(deploy).not.toContain('- main');
    expect(deploy).not.toContain('coi-serviceworker');
    expect(deploy).not.toContain('Cross-Origin-Opener-Policy');
  });

  it('Teiresias test.yml が兄弟 checkout を持ち、ブランチ非限定である', async () => {
    const ci = await readText('.github', 'workflows', 'test.yml');
    for (const needle of [
      'path: Teiresias',
      'repository: code4history/Daedalus',
      'repository: code4history/Atlas',
      'working-directory: Teiresias',
      'cache-dependency-path',
      'pnpm run test',
      'pnpm run typecheck',
      'pnpm run test:types',
      'pnpm run test:types:atlas',
      'pnpm run build',
      'pnpm run verify:demo',
      'pnpm run verify:demo-bundle',
    ]) {
      expect(ci).toContain(needle);
    }
    // 本ファイルはブランチ非限定である（設計 §6.5。Atlas 前例と同一）
    expect(ci).not.toContain('branches:');
  });

  it('Daedalus test.yml は単体 checkout で完結し、ブランチ非限定である', async () => {
    // ⚠️ 既知の妥協（設計 §9.1a の註 / R7 / §15-12）: 3 repo を分離した後、この相対パス
    // 参照は解決不能になる。Daedalus 側にテストを新設しないのは `Daedalus/tests/**` が
    // m0 凍結だからである。分離後は Daedalus 自身の CI が唯一の検査になる。
    const daedalusCi = await readFile(
      join(daedalusRoot, '.github', 'workflows', 'test.yml'),
      'utf8',
    );
    for (const needle of ['pnpm run test', 'pnpm run typecheck', 'pnpm run test:types', 'pnpm run build']) {
      expect(daedalusCi).toContain(needle);
    }
    expect(daedalusCi).not.toContain('branches:');
    // Daedalus は依存 0 件 ∴ 兄弟 checkout を持たない（設計 §6.4 末尾）
    expect(daedalusCi).not.toContain('repository: code4history/');
  });
});
