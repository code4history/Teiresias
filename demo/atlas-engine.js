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
import { DEFAULT_SCENE } from './scenes.js';

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
 * - `scene`   … 場面（`demo/scenes.js`）。省略すると京都。範囲と隣接 zone の ID は場面が持つ。
 * - `zones`   … 隣接 zone を含めた 3 件（京都なら `EPSG:6674` / `6673` / `6675`）。
 *               zone V / VI / VII を同時に含めるには CRS 側 bbox の膨張が要る
 *               （`bboxPaddingDeg: 0.7`。E2E の `catalogWide()` と同一設定）。
 * - `catalog` … padding を指定しない**既定カタログ全件**（実運用どおりの呼び出し）。
 *               縮退クラス `EPSG:2448 = EPSG:6674 = ESRI:112206` を含む。
 * - `catalog-custom` … 既定カタログ全件に custom の定義（歴史グリッド）を足す。
 *               custom の帯は陸上だけの絞り込みでは候補に残らないため `onshoreOnly: false` で引く。
 */
export async function loadCandidates(mode, scene = DEFAULT_SCENE) {
  const { listProjectedCrsFromProjWasm } = await loadAtlasRuntime();
  if (mode === 'zones') {
    const wide = await listProjectedCrsFromProjWasm({
      extent: scene.extent,
      area: 'Japan',
      onshoreOnly: true,
      bboxPaddingDeg: 0.7,
    });
    const byId = new Map(wide.map((row) => [row.id, row]));
    return scene.zones.filter((id) => byId.has(id)).map((id) => byId.get(id));
  }

  if (mode === 'catalog-custom') {
    return listProjectedCrsFromProjWasm({
      extent: scene.extent,
      area: 'Japan',
      onshoreOnly: false,
      includeCustomProjections: true,
    });
  }

  return listProjectedCrsFromProjWasm({
    extent: scene.extent,
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
 * - `rows` は呼び出し時に写す（後から `rows` を書き換えても結果は変わらない）。`unit` も写す —
 *   落とすと、単位が metre でない定義（歴史グリッドの yard）が「変換できなかった候補」になる。
 */
export function makeTransformer(rows) {
  const snapshot = rows.map((row) => ({
    id: row.id,
    proj4: row.proj4,
    ...(row.unit ? { unit: { ...row.unit } } : {}),
  }));
  const transformerPromise = loadAtlasRuntime().then(({ createCandidateTransformer }) =>
    createCandidateTransformer(snapshot),
  );
  return async (id, points, geoBasis) => (await transformerPromise)(id, points, geoBasis);
}

/**
 * 場面の真値（`scene.truthId`）へ場面の GCP（`scene.gcpLonLat`）を投影する
 * （pixel 格子の元になる座標）。`scene` を省略すると京都。
 *
 * 真値が metre でない定義（歴史グリッドの yard）でも座標を作れるよう、単位つきの
 * 変換の点列を使う。返す座標の単位は真値の行の単位であり、pixel 格子の縮尺はその単位の
 * 10 単位/pixel である。
 */
export async function projectTruth(rows, scene = DEFAULT_SCENE) {
  const { transformLonLatToCandidate } = await loadAtlasRuntime();
  const truthId = scene.truthId;
  const truth = rows.find((row) => row.id === truthId);
  if (truth === undefined) {
    throw new Error(`候補カタログに真値 ${truthId} が含まれていない`);
  }
  const converted = await transformLonLatToCandidate(truth, scene.gcpLonLat);
  if (converted === null) {
    throw new Error(`真値 ${truthId} への変換が null を返した`);
  }
  return converted.points;
}
