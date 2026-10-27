/**
 * Atlas adapter（m3-t1 設計 v1.3 §5.4）。
 *
 * `@c4h/atlas` を**動的 import** し、proj-wasm runtime の初期化・候補カタログの取得・
 * `CandidateTransformer` の生成を担う。**DOM を触らない。**
 *
 * 【C7】（Teiresias が engine を直参照しない）との関係: 不変条件は
 * `Teiresias/tests/package-shape.test.ts` が `src` 全域走査で担保しており、`demo/` は
 * `src` ではなく `tsconfig.json` の `include: ["src/**\/*"]` により公開 package にも
 * 入らない ∴ 本ファイルが `@c4h/atlas` を import することは【C7】に反しない
 * （テストが engine を注入するのと同じ位置づけである。設計 §4.4）。
 */
import { GCP_LONLAT, KYOTO_EXTENT, TRUE_ID } from './estimate-scene.js';

let atlasModulePromise;
let runtimePromise;

/**
 * proj-wasm の runtime asset の base URL を解く（`Atlas/demo/main.js:40-47` と同形）。
 *
 * ビルド後は本モジュール自身が `assets/` 配下に置かれる ∴ その場合は自分の隣を指す。
 * dev server ではページの 1 つ上を基準に `assets/` を指す。GitHub Pages の base path 差
 * （`/Teiresias/`）はこの解決で吸収される。
 */
export function projWasmAssetBaseUrl() {
  const modulePathSegments = new URL(import.meta.url).pathname.split('/');
  if (modulePathSegments.includes('assets')) {
    return new URL('./', import.meta.url);
  }

  const pageRoot = new URL('../', document.baseURI);
  return new URL('assets/', pageRoot);
}

function loadAtlasRuntime() {
  if (!atlasModulePromise) {
    atlasModulePromise = import('@c4h/atlas');
  }
  return atlasModulePromise;
}

/**
 * `@c4h/atlas` を 1 回だけ読み、proj-wasm runtime の初期化完了まで待つ。
 *
 * ⚠️ **`__TEIRESIAS_PROJ_WASM_ASSET_BASE_URL__` は本ファイルが設定する。**
 * 設計 K9 は proj-wasm の asset base URL のグローバル名を Atlas と分けると定めたが、
 * その global を**書く**のは Atlas 側のコード（`installProjWasmAssetResolver` が
 * `__ATLAS_PROJ_WASM_ASSET_BASE_URL__` を書く）である ∴ 名前を分けたままにすると
 * **書き手が居なくなり、worker URL の解決が既定へ落ちる**（実装で判明した接続点。
 * 設計は「同じ機構・名前だけ変える」としか書いていなかった）。
 * ∴ **Teiresias 側の global は Teiresias 側で書く。** これで K9 の名前空間分離を
 * 保ったまま、Atlas の setter に依存しない。
 */
export function loadEngine() {
  if (!runtimePromise) {
    runtimePromise = (async () => {
      const baseUrl = projWasmAssetBaseUrl();
      globalThis.__TEIRESIAS_PROJ_WASM_ASSET_BASE_URL__ = baseUrl.href;
      const { initializeProjWasmRuntime } = await loadAtlasRuntime();
      await initializeProjWasmRuntime({ projWasmAssetBaseUrl: baseUrl });
      return true;
    })();
  }
  return runtimePromise;
}

/**
 * 候補 CRS を読む。
 *
 * - `zones`   … 隣接 zone を含めた 3 件（`EPSG:6674` / `6673` / `6675`）。
 *               zone V / VI / VII を同時に含めるには CRS 側 bbox の膨張が要る
 *               （`bboxPaddingDeg: 0.7`。E2E の `catalogWide()` と同一設定）。
 * - `catalog` … padding を指定しない**既定カタログ全件**（実運用どおりの呼び出し）。
 *               縮退クラス `EPSG:2448 = EPSG:6674 = ESRI:112206` を含む。
 */
export async function loadCandidates(mode) {
  const { listProjectedCrsFromProjWasm } = await loadAtlasRuntime();
  if (mode === 'zones') {
    const wide = await listProjectedCrsFromProjWasm({
      extent: KYOTO_EXTENT,
      area: 'Japan',
      onshoreOnly: true,
      bboxPaddingDeg: 0.7,
    });
    const wanted = ['EPSG:6674', 'EPSG:6673', 'EPSG:6675'];
    const byId = new Map(wide.map((row) => [row.id, row]));
    return wanted.filter((id) => byId.has(id)).map((id) => byId.get(id));
  }

  return listProjectedCrsFromProjWasm({
    extent: KYOTO_EXTENT,
    area: 'Japan',
    onshoreOnly: true,
  });
}

/**
 * `CandidateTransformer` を作る。生成は Atlas の公開 adapter `createCandidateTransformer` に任せ、
 * 本ファイルは `@c4h/atlas` の動的 import を待つ包みだけを持つ（E2E
 * `estimate-crs.real-engine.e2e.test.ts` と同じ adapter を使う）。
 *
 * - `geoBasis` が `lonlat_deg` / lon-lat 順でなければ `null`、知らない id も `null`
 *   （契約 (7)「業務的変換不能」）。実装側の失敗は throw で伝わる（契約 (7)）。
 * - `rows` は呼び出し時に写す（後から `rows` を書き換えても結果は変わらない）。
 */
export function makeTransformer(rows) {
  const snapshot = rows.map((row) => ({ id: row.id, proj4: row.proj4 }));
  const transformerPromise = loadAtlasRuntime().then(({ createCandidateTransformer }) =>
    createCandidateTransformer(snapshot),
  );
  return async (id, points, geoBasis) => (await transformerPromise)(id, points, geoBasis);
}

/** 真値 `EPSG:6674` へ `GCP_LONLAT` を投影する（pixel 格子の元になる座標）。 */
export async function projectTruth(rows) {
  const { transformLonLatArrayToProjected } = await loadAtlasRuntime();
  const truth = rows.find((row) => row.id === TRUE_ID);
  if (truth === undefined) {
    throw new Error(`候補カタログに真値 ${TRUE_ID} が含まれていない`);
  }
  const projected = await transformLonLatArrayToProjected(truth, GCP_LONLAT);
  if (projected === null) {
    throw new Error(`真値 ${TRUE_ID} への変換が null を返した`);
  }
  return projected;
}
