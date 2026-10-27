// @vitest-environment jsdom
/**
 * デモの DOM 結線 E2E（m3-t1 設計 v1.3 §9.1 / m3-t1/AC-6）。
 *
 * 対応 AC:
 * - (a) `#y-flip` の `change` で再計算が **1 回**起きる
 * - (b) `#candidate-mode` の `change` で候補モードが engine へ渡る
 * - (c) `#reset-gcp` の `click` で pixel が初期値へ戻る
 * - (d) `#ranked-body` の行数が `ranked.length` と一致する
 * - (e) `discrimination.collapsed` が真のとき「識別力が潰れている」バッジが出る
 *   （正規化 off で y 反転したとき。正規化 on〔既定〕では y 反転しても潰れない — (e')）
 * - `#chirality`（反射を吸収する）の `change` で再計算が 1 回起きる
 * - (f) `canvas.getContext('2d')` が `null` を返す環境で `initDemo` が例外を投げず、
 *       (a)〜(e) がすべて成立する
 *
 * ## (f) の検査の性格（設計 §5.4(1) / K21）
 *
 * **jsdom は canvas 2D を実装していない** ∴ 補助 package（`canvas`）を入れない限り
 * `getContext('2d')` は `null` を返す。**本ファイルは `getContext` を stub しない** —
 * stub すると (f) を検査したことにならない。∴ **(a)〜(e) が通ること自体が (f) の証拠**で
 * あり、加えて `hasContext` が両方 `false` であることを明示 assert する。
 *
 * ## stub するもの / しないもの（設計 §5.4(1) の裁量事項。task-state にも記録する）
 *
 * | 対象 | 扱い | 理由 |
 * |---|---|---|
 * | `engine`（Atlas adapter） | **stub を注入** | 実 engine は AC-5 が受け持つ。本ファイルは結線だけを見る |
 * | `canvas.getContext` | **stub しない** | stub すると (f) が vacuous になる |
 * | `canvas.getBoundingClientRect` | **stub する** | jsdom は常に全 0 を返す ∴ ヒットテストが物理的に成立しない。
 *   これは「実装のロジックを再現する」stub ではなく、**レイアウト計算のない環境に寸法を与える**だけである |
 *
 * DOM は `demo/crs-estimate-ranking.html` を**実際に読んで**組む（手で書いた DOM を使うと
 * ページ側の id が変わったときに検査が追随しない）。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Y_SCALE_SIGN_LABELS, initDemo } from '../demo/main.js';
import { GCP_LONLAT } from '../demo/estimate-scene.js';
import { PRESETS, PRESET_OPTION_IDS, findPreset } from '../demo/presets.js';
import { scenes } from '../demo/scenes.js';

// ---------------------------------------------------------------------------
// ページの自動起動の検査用（`demo/atlas-engine.js` を最小の module に差し替える）
// ---------------------------------------------------------------------------

/**
 * 自動起動の検査だけは、ページと同じく**既定の engine**（`demo/atlas-engine.js`）を読む経路を
 * 通る。実 engine は proj-wasm の runtime を要し、jsdom では起動できない ∴ ここだけ最小の
 * module に差し替える（他の検査は `initDemo({ engine })` で stub を注入するので影響を受けない）。
 */
const autoInitStub = vi.hoisted(() => ({ loadCandidatesCalls: 0 }));

vi.mock('../demo/atlas-engine.js', () => {
  const scale = 100_000;
  const row = { id: 'EPSG:6674', authority: 'EPSG', code: '6674', sx: scale, sy: scale };
  const project = (points: ReadonlyArray<readonly [number, number]>) =>
    points.map(([lon, lat]: readonly [number, number]) => [(lon - 135.75) * scale, (lat - 35) * scale]);
  return {
    loadEngine: async () => true,
    loadCandidates: async () => {
      autoInitStub.loadCandidatesCalls += 1;
      return [row];
    },
    makeTransformer: () => async (_id: string, points: ReadonlyArray<readonly [number, number]>) => project(points),
    projectTruth: async () =>
      project([
        [135.6, 34.9],
        [135.9, 34.9],
        [135.9, 35.1],
        [135.6, 35.1],
        [135.75, 35.0],
      ]),
  };
});

// ---------------------------------------------------------------------------
// stub engine（決定的。実 proj-wasm を使わない）
// ---------------------------------------------------------------------------

const LON0 = 135.75;
const LAT0 = 35.0;
const SCALE = 100_000;

/**
 * 投影の定義（`proj4` の文字列）。stub は実際には投影しないが、`runScene` はこの文字列の
 * 一致で「同値」（真値と同じ定義）を判定する ∴ stub の候補の定義はここで決める。
 */
const DEFINITION_VI =
  '+proj=tmerc +lat_0=36 +lon_0=135 +k=0.9999 +x_0=0 +y_0=0 +ellps=GRS80 +units=m +no_defs';
const DEFINITION_VI_EAST =
  '+proj=tmerc +lat_0=36 +lon_0=135.5 +k=0.9999 +x_0=0 +y_0=0 +ellps=GRS80 +units=m +no_defs';
const DEFINITION_VII =
  '+proj=tmerc +lat_0=36 +lon_0=135 +k=1 +x_0=0 +y_0=0 +ellps=GRS80 +units=m +no_defs';
const DEFINITION_TOKYO =
  '+proj=tmerc +lat_0=36 +lon_0=139.833333 +k=0.9999 +x_0=0 +y_0=0 +ellps=GRS80 +units=m +no_defs';
const DEFINITION_HISTORICAL_B =
  '+proj=pipeline +step +inv +proj=poly +lat_0=40.5 +lon_0=135 +x_0=914398.5307444408 +y_0=1828797.0614888816 +ellps=clrk66 +to_meter=0.9143985307444408';
const DEFINITION_HISTORICAL_A =
  '+proj=pipeline +step +inv +proj=poly +lat_0=40.5 +lon_0=143 +x_0=914398.5307444408 +y_0=1828797.0614888816 +ellps=clrk66 +to_meter=0.9143985307444408';
const DEFINITION_HISTORICAL_C =
  '+proj=pipeline +step +inv +proj=poly +lat_0=40.5 +lon_0=127 +x_0=914398.5307444408 +y_0=1828797.0614888816 +ellps=clrk66 +to_meter=0.9143985307444408';

/**
 * 歴史グリッドの単位（stub が返す）。実 engine の `UTJCP` の行と同じ値を使う
 * （metre でない候補は `{ points, unit }` を返し、その単位が画面へ出る）。
 */
const HISTORICAL_UNIT = Object.freeze({
  name: 'yard (Japan City Plans)',
  metresPerUnit: 0.9143985307444408,
});

/** 変換できない（transformer が `null` を返す）候補。 */
const UNTRANSFORMABLE_ID = 'EPSG:9991';
/** 変換はできるが当てはめに使えない（全点が同じ座標になる）候補。 */
const UNFITTABLE_ID = 'EPSG:9992';
/** 真値と同じ `proj4` を持つ（「同値」の印が付く）候補。 */
const SAME_DEFINITION_ID = 'EPSG:2448';
/** 識別力で比べる相手（1 位と同じ定義の候補を飛ばした最初の行）。 */
const DISCRIMINATION_AGAINST_ID = 'EPSG:6673';

const UNTRANSFORMABLE_IDS = new Set([UNTRANSFORMABLE_ID]);
const UNFITTABLE_IDS = new Set([UNFITTABLE_ID]);

/**
 * 京都の候補。真値だけが**等方スケール**（= 相似変換で厳密適合する）であり、他の行は
 * わずかに非等方である ∴
 *   - 反射なし … 真値 rms = 0 → 比は Infinity（識別できている）
 *   - 反射あり … 全行が反射由来の巨大残差に支配され、差は `1e-3` 相対 → 比は 1.0x（潰れる）
 * これは実 engine で観測される現象（`1.000199…`）と**同じ構造**である。
 *
 * 流れの 3 つの件数を 1 つずつ違えるため、`null` を返す行と当てはめに使えない行を混ぜる。
 */
const STUB_CANDIDATES = [
  { id: 'EPSG:6674', authority: 'EPSG', code: '6674', sx: SCALE, sy: SCALE, proj4: DEFINITION_VI },
  {
    id: SAME_DEFINITION_ID,
    authority: 'EPSG',
    code: '2448',
    sx: SCALE * (1 + 5e-5),
    sy: SCALE,
    proj4: DEFINITION_VI,
  },
  {
    id: DISCRIMINATION_AGAINST_ID,
    authority: 'EPSG',
    code: '6673',
    sx: SCALE,
    sy: SCALE * (1 + 1e-3),
    proj4: DEFINITION_VI_EAST,
  },
  {
    id: 'EPSG:6675',
    authority: 'EPSG',
    code: '6675',
    sx: SCALE * (1 + 2e-3),
    sy: SCALE,
    proj4: DEFINITION_VII,
  },
  { id: UNTRANSFORMABLE_ID, authority: 'EPSG', code: '9991', sx: SCALE, sy: SCALE },
  { id: UNFITTABLE_ID, authority: 'EPSG', code: '9992', sx: 0, sy: 0 },
];

/** 東京の場面用。真値（`scenes.tokyo.truthId`）だけが等方スケールである。 */
const STUB_TOKYO_CANDIDATES = [
  {
    id: scenes.tokyo.truthId,
    authority: 'EPSG',
    code: '6677',
    sx: SCALE,
    sy: SCALE,
    proj4: DEFINITION_TOKYO,
  },
  {
    id: 'EPSG:6678',
    authority: 'EPSG',
    code: '6678',
    sx: SCALE * (1 + 5e-5),
    sy: SCALE,
    proj4: DEFINITION_TOKYO,
  },
  { id: 'EPSG:6676', authority: 'EPSG', code: '6676', sx: SCALE, sy: SCALE * (1 + 1e-3) },
  {
    id: scenes.kyoto.truthId,
    authority: 'EPSG',
    code: '6674',
    sx: SCALE * (1 + 2e-3),
    sy: SCALE,
    proj4: DEFINITION_VI,
  },
  { id: UNTRANSFORMABLE_ID, authority: 'EPSG', code: '9991', sx: SCALE, sy: SCALE },
  { id: UNFITTABLE_ID, authority: 'EPSG', code: '9992', sx: 0, sy: 0 },
];

const EXTRA_CANDIDATE = {
  id: 'EPSG:3094',
  authority: 'EPSG',
  code: '3094',
  sx: SCALE * 1.5,
  sy: SCALE * 1.5,
};

/** 歴史グリッドの 3 帯（custom projection）。帯ごとに微妙に曲げが違い、真値の帯だけが厳密適合する。 */
const HISTORICAL_ROW_B = {
  id: 'UTJCP:ZONE-B',
  authority: 'UTJCP',
  code: 'ZONE-B',
  sx: SCALE * 0.9,
  sy: SCALE * 0.9,
  bend: 5e-6,
  proj4: DEFINITION_HISTORICAL_B,
  unit: HISTORICAL_UNIT,
};
const HISTORICAL_ROW_A = {
  id: 'UTJCP:ZONE-A',
  authority: 'UTJCP',
  code: 'ZONE-A',
  sx: SCALE * 1.1,
  sy: SCALE * 1.1,
  bend: 7e-6,
  proj4: DEFINITION_HISTORICAL_A,
  unit: HISTORICAL_UNIT,
};
const HISTORICAL_ROW_C = {
  id: 'UTJCP:ZONE-C',
  authority: 'UTJCP',
  code: 'ZONE-C',
  sx: SCALE * 1.2,
  sy: SCALE * 1.2,
  bend: 9e-6,
  proj4: DEFINITION_HISTORICAL_C,
  unit: HISTORICAL_UNIT,
};

/**
 * 歴史グリッドの場面（京都と同じ範囲）の候補。真値（`UTJCP:ZONE-B`）だけが等方スケールで、
 * 単位は yard である。変換できない行と当てはめに使えない行を混ぜ、流れの 3 つの件数を
 * 1 つずつ違える。
 */
const STUB_UTJCP_CANDIDATES = [
  HISTORICAL_ROW_B,
  { id: 'EPSG:6674', authority: 'EPSG', code: '6674', sx: SCALE, sy: SCALE, proj4: DEFINITION_VI },
  {
    id: SAME_DEFINITION_ID,
    authority: 'EPSG',
    code: '2448',
    sx: SCALE * (1 + 5e-5),
    sy: SCALE,
    proj4: DEFINITION_VI,
  },
  {
    id: DISCRIMINATION_AGAINST_ID,
    authority: 'EPSG',
    code: '6673',
    sx: SCALE,
    sy: SCALE * (1 + 1e-3),
    proj4: DEFINITION_VI_EAST,
  },
  {
    id: 'EPSG:6675',
    authority: 'EPSG',
    code: '6675',
    sx: SCALE * (1 + 2e-3),
    sy: SCALE,
    proj4: DEFINITION_VII,
  },
  { id: UNTRANSFORMABLE_ID, authority: 'EPSG', code: '9991', sx: SCALE, sy: SCALE },
  { id: UNFITTABLE_ID, authority: 'EPSG', code: '9992', sx: 0, sy: 0 },
];

type StubRow = (typeof STUB_CANDIDATES)[number] & {
  unit?: { name: string; metresPerUnit: number };
  bend?: number;
};

function projectWith(row: StubRow, points: ReadonlyArray<readonly [number, number]>) {
  const bend = row.bend ?? 0;
  return points.map(([lon, lat]): [number, number] => {
    const dx = lon - LON0;
    const dy = lat - LAT0;
    return [
      dx * row.sx + bend * dx * row.sx * dy,
      dy * row.sy + bend * dy * row.sy * dx,
    ];
  });
}

/** 場面と候補の集め方から stub の候補を決める（場面ごとに真値が違い、custom は catalog-custom だけに足す）。 */
function stubCandidatesFor(mode: string, scene: { id?: string } | undefined): StubRow[] {
  const base: StubRow[] =
    scene?.id === 'kyoto-utjcp'
      ? [...STUB_UTJCP_CANDIDATES]
      : scene?.id === scenes.tokyo.id
        ? [...STUB_TOKYO_CANDIDATES]
        : [...STUB_CANDIDATES];
  if (mode === 'zones') return base;
  if (mode === 'catalog') return [...base, EXTRA_CANDIDATE];
  // catalog-custom: 既定カタログ全件 + custom の 3 帯（真値の帯を二重に足さない）。
  const historicalExtras = [HISTORICAL_ROW_A, HISTORICAL_ROW_B, HISTORICAL_ROW_C].filter(
    (row) => !base.some((entry) => entry.id === row.id),
  );
  return [...base, ...historicalExtras];
}

/**
 * 流れの表示に出るはずの 3 つの件数を、**stub の定義だけ**から決める
 * （候補の件数・変換できた件数・当てはめた件数）。
 */
function expectedFlowFor(mode: string, scene: { id?: string } | undefined) {
  const rows = stubCandidatesFor(mode, scene);
  const transformable = rows.filter((row) => !UNTRANSFORMABLE_IDS.has(row.id));
  const fittable = transformable.filter((row) => !UNFITTABLE_IDS.has(row.id));
  return { candidates: rows.length, transformed: transformable.length, fitted: fittable.length };
}

function makeStubEngine() {
  const loadCandidates = vi.fn(async (mode: string, scene?: { id?: string }) => stubCandidatesFor(mode, scene));
  return {
    loadEngine: vi.fn(async () => true),
    loadCandidates,
    makeTransformer: vi.fn((rows: StubRow[]) => {
      const byId = new Map(rows.map((row) => [row.id, row]));
      return (id: string, points: ReadonlyArray<readonly [number, number]>, geoBasis: { kind: string; axisOrder: string }) => {
        if (geoBasis.kind !== 'lonlat_deg' || geoBasis.axisOrder !== 'lon-lat') return null;
        if (UNTRANSFORMABLE_IDS.has(id)) return null;
        const target = byId.get(id);
        if (target === undefined) return null;
        const projected = projectWith(target, points);
        // metre でない候補（歴史グリッド）は単位つきで返す（実 engine の adapter と同じ形）。
        return target.unit === undefined ? projected : { points: projected, unit: { ...target.unit } };
      };
    }),
    // 真値の投影は**渡された場面**の GCP を使う（場面を取り違えれば値が変わる）。
    projectTruth: vi.fn(async (rows: StubRow[], scene?: { id?: string; truthId?: string; gcpLonLat?: unknown }) => {
      const place = scene ?? scenes.kyoto;
      const truthId = place.truthId ?? scenes.kyoto.truthId;
      const row = rows.find((entry) => entry.id === truthId);
      if (row === undefined) throw new Error(`stub の候補に真値 ${truthId} が無い`);
      return projectWith(row, place.gcpLonLat as ReadonlyArray<readonly [number, number]>);
    }),
  };
}

/**
 * すべての候補の変換で例外を投げる engine。推定は `status: 'failed'` と `failure` を返す ∴
 * 流れの行が失敗の表示になる。
 */
function makeFailingEngine() {
  const base = makeStubEngine();
  return {
    loadEngine: base.loadEngine,
    loadCandidates: base.loadCandidates,
    makeTransformer: vi.fn(() => () => {
      throw new Error('stub の変換は失敗する');
    }),
    projectTruth: base.projectTruth,
  };
}

// ---------------------------------------------------------------------------
// DOM 構築（実ページの body を読み込む）
// ---------------------------------------------------------------------------

// ⚠️ jsdom 環境では global の `URL` が jsdom（whatwg-url）のものへ差し替わっており、
// `readFileSync(new URL(...))` は Node の URL ブランド検査に落ちる
// （実測: `TypeError: The URL must be of scheme file`）∴ 文字列パスで渡す。
const testsDir = dirname(fileURLToPath(import.meta.url));
const pageHtml = readFileSync(join(testsDir, '..', 'demo', 'crs-estimate-ranking.html'), 'utf8');
const bodyInner = /<body[^>]*>([\s\S]*)<\/body>/i.exec(pageHtml)?.[1];

function mountPage(): void {
  if (bodyInner === undefined) throw new Error('crs-estimate-ranking.html から body を取り出せない');
  document.body.innerHTML = bodyInner.replace(/<script[\s\S]*?<\/script>/gi, '');
  const canvas = document.getElementById('pixel-canvas') as HTMLCanvasElement;
  // jsdom はレイアウトを持たず getBoundingClientRect が全 0 を返す ∴ 寸法だけ与える。
  canvas.getBoundingClientRect = () =>
    ({ left: 0, top: 0, right: 380, bottom: 300, width: 380, height: 300, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
}

function pointer(type: string, clientX: number, clientY: number): Event {
  const event = new MouseEvent(type, { clientX, clientY, bubbles: true });
  return event;
}

describe('m3-t1/AC-6: デモの DOM 結線（jsdom / stub engine 注入）', () => {
  beforeEach(() => {
    mountPage();
  });

  it('(f) canvas 2D が無い環境（jsdom そのもの）でも initDemo が例外を投げず初期化を完了する', async () => {
    const engine = makeStubEngine();
    const demo = initDemo({ engine });
    await demo.whenSettled();

    const state = demo.getState();
    // **getContext を stub していない**ことの明示 assert。両方 false でなければ
    // (f) は検査されていない（設計 §5.4(1) / K21）。
    expect(state.hasContext).toEqual({ geo: false, pixel: false });
    expect(state.ready).toBe(true);
    expect(demo.getRecalcCount()).toBe(1);
    expect(document.getElementById('error')?.textContent).toBe('');
    expect(document.getElementById('status')?.textContent).toContain('計算完了');
  });

  /**
   * 回帰テスト（m3-t1/AC-16 の実ブラウザ観測で発見した欠陥）。
   *
   * 実装は world file の 6 係数を ESRI の行名（A/D/B/E/C/F）で読み出していたが、
   * `@c4h/daedalus` の `WorldFile` の実キーは
   * `xScale` / `xSkew` / `xOrigin` / `ySkew` / `yScale` / `yOrigin` である
   * （実測: `Daedalus/src/types.ts:3-10`）∴ 画面に `A=undefined D=undefined …` と出ていた。
   * jsdom テストは当初「選択結果が描画されること」しか見ておらず、**値が undefined でも
   * 通っていた** ∴ 値そのものを assert する検査を足す。
   */
  it('選択結果の world file が 6 係数とも実値で表示される（undefined を出さない）', async () => {
    const engine = makeStubEngine();
    const demo = initDemo({ engine });
    await demo.whenSettled();

    const selected = document.getElementById('selected-body') as HTMLElement;
    const text = selected.textContent ?? '';
    for (const key of ['xScale', 'xSkew', 'xOrigin', 'ySkew', 'yScale', 'yOrigin']) {
      expect(text).toContain(key);
    }
    expect(text).not.toContain('undefined');
    expect(text).toContain('EPSG:6674');
  });

  it('(d) #ranked-body の行数が ranked.length と一致する', async () => {
    const engine = makeStubEngine();
    const demo = initDemo({ engine });
    await demo.whenSettled();

    const rows = document.querySelectorAll('#ranked-body tr');
    expect(rows.length).toBe(demo.getState().scene.ranked.length);
    expect(rows.length).toBe(expectedFlowFor('zones', scenes.kyoto).fitted);
    // 反射なしでは真値が 1 位
    expect(rows[0].children[1].textContent).toBe('EPSG:6674');
    expect(rows[0].children[4].textContent).toBe('真値');
  });

  it('(a) #y-flip の change で再計算が 1 回だけ起きる', async () => {
    const engine = makeStubEngine();
    const demo = initDemo({ engine });
    await demo.whenSettled();
    const before = demo.getRecalcCount();

    const checkbox = document.getElementById('y-flip') as HTMLInputElement;
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change'));
    await demo.whenSettled();

    expect(demo.getRecalcCount()).toBe(before + 1);
    expect(demo.getState().yFlip).toBe(true);
    // 候補カタログは読み直さない（y 反転は候補集合を変えない）
    expect(engine.loadCandidates).toHaveBeenCalledTimes(1);
  });

  it('(e) 正規化 off で y 反転すると識別力が潰れ、「識別力が潰れている」バッジが出る', async () => {
    const engine = makeStubEngine();
    const demo = initDemo({ engine });
    await demo.whenSettled();

    const discrimination = document.getElementById('discrimination') as HTMLElement;
    expect(discrimination.textContent).toContain('識別できている');
    expect(discrimination.querySelector('.teiresias-badge-collapsed')).toBeNull();

    const chirality = document.getElementById('chirality') as HTMLInputElement;
    chirality.checked = false;
    chirality.dispatchEvent(new Event('change'));
    const checkbox = document.getElementById('y-flip') as HTMLInputElement;
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change'));
    await demo.whenSettled();

    expect(demo.getState().chirality).toBe('direct-only');
    expect(demo.getState().scene.discrimination.collapsed).toBe(true);
    expect(discrimination.textContent).toContain('識別力が潰れている');
    expect(discrimination.querySelector('.teiresias-badge-collapsed')).not.toBeNull();
  });

  it("(e') 正規化 on（既定）では y 反転しても識別できていて、真値が 1 位・yScale が負になる", async () => {
    const engine = makeStubEngine();
    const demo = initDemo({ engine });
    await demo.whenSettled();

    const chirality = document.getElementById('chirality') as HTMLInputElement;
    expect(chirality.checked).toBe(true);
    expect(demo.getState().chirality).toBe('normalize');

    const checkbox = document.getElementById('y-flip') as HTMLInputElement;
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change'));
    await demo.whenSettled();

    const scene = demo.getState().scene;
    expect(scene.discrimination.collapsed).toBe(false);
    expect(scene.ranked[0].id).toBe('EPSG:6674');
    expect(scene.selected.worldFile.yScale).toBeLessThan(0);
    const discrimination = document.getElementById('discrimination') as HTMLElement;
    expect(discrimination.textContent).toContain('識別できている');
    expect(discrimination.querySelector('.teiresias-badge-collapsed')).toBeNull();
  });

  it('#chirality の change で再計算が 1 回だけ起き、候補カタログは読み直さない', async () => {
    const engine = makeStubEngine();
    const demo = initDemo({ engine });
    await demo.whenSettled();
    const before = demo.getRecalcCount();

    const chirality = document.getElementById('chirality') as HTMLInputElement;
    chirality.checked = false;
    chirality.dispatchEvent(new Event('change'));
    await demo.whenSettled();

    expect(demo.getRecalcCount()).toBe(before + 1);
    expect(demo.getState().chirality).toBe('direct-only');
    expect(engine.loadCandidates).toHaveBeenCalledTimes(1);
  });

  it('(b) #candidate-mode の change で候補モードが engine へ渡る', async () => {
    const engine = makeStubEngine();
    const demo = initDemo({ engine });
    await demo.whenSettled();
    expect(engine.loadCandidates).toHaveBeenCalledWith('zones', scenes.kyoto);

    const select = document.getElementById('candidate-mode') as HTMLSelectElement;
    select.value = 'catalog';
    select.dispatchEvent(new Event('change'));
    await demo.whenSettled();

    expect(engine.loadCandidates).toHaveBeenCalledTimes(2);
    expect(engine.loadCandidates).toHaveBeenLastCalledWith('catalog', scenes.kyoto);
    expect(demo.getState().candidateMode).toBe('catalog');
    expect(document.querySelectorAll('#ranked-body tr').length).toBe(
      expectedFlowFor('catalog', scenes.kyoto).fitted,
    );
  });

  it('(c) ドラッグで pixel が動き、#reset-gcp の click で初期値へ戻る', async () => {
    const engine = makeStubEngine();
    const demo = initDemo({ engine });
    await demo.whenSettled();

    const basePixels = demo.getState().basePixels;
    const canvas = document.getElementById('pixel-canvas') as HTMLCanvasElement;

    // マーカー 0 の board 座標を求めるかわりに、板の中央付近まで総当たりで掴む。
    // （board 座標は内部の mapper が決める ∴ テストから逆算せず、掴めるまで走査する）
    let grabbed = false;
    for (let bx = 0; bx <= 380 && !grabbed; bx += 4) {
      for (let by = 0; by <= 300 && !grabbed; by += 4) {
        canvas.dispatchEvent(pointer('pointerdown', bx, by));
        canvas.dispatchEvent(pointer('pointermove', bx + 40, by + 30));
        canvas.dispatchEvent(pointer('pointerup', bx + 40, by + 30));
        await demo.whenSettled();
        grabbed = JSON.stringify(demo.getState().pixels) !== JSON.stringify(basePixels);
      }
    }
    expect(grabbed).toBe(true);

    const resetButton = document.getElementById('reset-gcp') as HTMLButtonElement;
    resetButton.dispatchEvent(new Event('click'));
    await demo.whenSettled();

    expect(demo.getState().pixels).toEqual(basePixels);
  });
});

// ---------------------------------------------------------------------------
// プリセットの帯・流れの表示・選択結果の追加分
// ---------------------------------------------------------------------------

/** 帯のボタン（`data-preset="<対比の名前>:<a|b>"`）。 */
function presetButtons(): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll('#preset-bar button[data-preset]')) as HTMLButtonElement[];
}

/** 押されている（`aria-pressed="true"`）ボタンの名前。 */
function pressedPresets(): string[] {
  return presetButtons()
    .filter((button) => button.getAttribute('aria-pressed') === 'true')
    .map((button) => button.dataset.preset ?? '');
}

/** 見え方の 1 行。 */
function expectationText(): string {
  return document.getElementById('preset-expectation')?.textContent ?? '';
}

/** 流れの表示の 1 行に出ている数を出た順に読む。 */
function flowNumbers(): number[] {
  const text = document.getElementById('flow')?.textContent ?? '';
  return (text.match(/\d+/g) ?? []).map(Number);
}

function flowText(): string {
  return document.getElementById('flow')?.textContent ?? '';
}

function discriminationText(): string {
  return document.getElementById('discrimination')?.textContent ?? '';
}

function resultCountText(): string {
  return document.getElementById('result-count')?.textContent ?? '';
}

/**
 * 画面の比の書式（`formatRatio` と同じ規則）。比の数値が stub の結果どおりに
 * 6 桁で出ているかを見るために使う。
 */
function formatRatioForTest(ratio: number | null): string {
  if (ratio === null) return '—';
  if (!Number.isFinite(ratio)) return '∞';
  if (ratio >= 1e4) return ratio.toExponential(4);
  return ratio.toFixed(6);
}

/** 順位の表の「真値」の列の番号（見出しから引く。位置を直書きしない）。 */
function truthColumnIndex(): number {
  return Array.from(document.querySelectorAll('thead th')).findIndex((th) => th.textContent === '真値');
}

/** 順位の表の行から、ID で引いた行の「真値」のセルの中身。 */
function truthMarkOf(id: string): string | null {
  const rows = Array.from(document.querySelectorAll('#ranked-body tr'));
  const row = rows.find((entry) => entry.children[1]?.textContent === id);
  if (row === undefined) return null;
  return row.children[truthColumnIndex()]?.textContent ?? '';
}

/** 順位の表の見出しの番号（見出しの文字列から引く。位置を直書きしない）。 */
function columnIndexOf(header: string): number {
  return Array.from(document.querySelectorAll('thead th')).findIndex((th) => th.textContent === header);
}

/** 順位の表の行から、ID で引いた行の指定の列のセルの中身。 */
function cellOf(id: string, columnIndex: number): string | null {
  const rows = Array.from(document.querySelectorAll('#ranked-body tr'));
  const row = rows.find((entry) => entry.children[1]?.textContent === id);
  if (row === undefined) return null;
  return row.children[columnIndex]?.textContent ?? '';
}

/** 選択結果の詳細リスト（`dt` と `dd` の並び）から、用語の次の値を引く。 */
function definitionOf(term: string): string | null {
  const terms = Array.from(document.querySelectorAll('#selected-body dt'));
  const dt = terms.find((entry) => entry.textContent === term);
  if (dt === undefined) return null;
  return dt.nextElementSibling?.textContent ?? null;
}

/** 画面の数の書式（`formatMeters` と同じ規則）。値を値のまま確かめるために使う。 */
function formatMetersForTest(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (value === 0) return '0';
  if (Math.abs(value) < 1e-3 || Math.abs(value) >= 1e5) return value.toExponential(4);
  return value.toFixed(4);
}

/** 板が実際にマーカーを掴むまで走査してドラッグし、掴めたかを返す（jsdom には寸法が無い）。 */
async function dragFirstMarker(demo: ReturnType<typeof initDemo>): Promise<boolean> {
  const before = JSON.stringify(demo.getState().pixels);
  const canvas = document.getElementById('pixel-canvas') as HTMLCanvasElement;
  for (let bx = 0; bx <= 380; bx += 4) {
    for (let by = 0; by <= 300; by += 4) {
      canvas.dispatchEvent(pointer('pointerdown', bx, by));
      canvas.dispatchEvent(pointer('pointermove', bx + 40, by + 30));
      if (JSON.stringify(demo.getState().pixels) !== before) {
        canvas.dispatchEvent(pointer('pointerup', bx + 40, by + 30));
        await demo.whenSettled();
        return true;
      }
      // 掴めなかったときは離してから次を探す（ドラッグ中の状態を持ち越さない）
      canvas.dispatchEvent(pointer('pointerup', bx, by));
      await demo.whenSettled();
    }
  }
  return false;
}

describe('プリセットの帯（ボタン → 入力・計算 1 回・見え方の 1 行）', () => {
  beforeEach(() => {
    mountPage();
  });

  it('帯には対比ごとに A・B の 2 つのボタンが、プリセットの文言で並ぶ', async () => {
    const demo = initDemo({ engine: makeStubEngine() });
    await demo.whenSettled();

    const names = presetButtons().map((button) => button.dataset.preset);
    const expected = PRESETS.flatMap((preset) => PRESET_OPTION_IDS.map((optionId) => `${preset.id}:${optionId}`));
    expect(names).toEqual(expected);

    for (const preset of PRESETS) {
      for (const optionId of PRESET_OPTION_IDS) {
        const option = findPreset(preset.id, optionId)!;
        const button = document.querySelector(`button[data-preset="${preset.id}:${optionId}"]`);
        expect(button?.textContent).toBe(option.label);
      }
    }
    // まだ何も押していない ∴ 強調も見え方も無い（中立）
    expect(pressedPresets()).toEqual([]);
    expect(expectationText()).toBe('');
  });

  for (const preset of PRESETS) {
    for (const optionId of PRESET_OPTION_IDS) {
      it(`${preset.id}:${optionId} を押すと定義どおりの入力が入り、計算が 1 回だけ走る`, async () => {
        const option = findPreset(preset.id, optionId)!;
        const engine = makeStubEngine();
        const demo = initDemo({ engine });
        await demo.whenSettled();
        const recalcBefore = demo.getRecalcCount();

        const button = document.querySelector(`button[data-preset="${preset.id}:${optionId}"]`) as HTMLButtonElement;
        expect(button).not.toBeNull();
        button.dispatchEvent(new Event('click'));
        await demo.whenSettled();

        // 入力が一度に入る
        const state = demo.getState();
        expect(state.sceneId).toBe(option.scene.id);
        expect(state.candidateMode).toBe(option.input.candidateMode);
        expect(state.yFlip).toBe(option.input.yFlip);
        expect(state.chirality).toBe(option.input.chirality);
        // 場面と候補の集め方が engine へ渡り、候補の読み直しは 1 回だけ（起動の 1 回を足して 2 回）
        expect(engine.loadCandidates).toHaveBeenLastCalledWith(option.input.candidateMode, option.scene);
        expect(engine.loadCandidates).toHaveBeenCalledTimes(2);
        // 計算は 1 回だけ走る
        expect(demo.getRecalcCount()).toBe(recalcBefore + 1);

        // つまみも入力どおりになる（押した後に手で触れる状態である）
        expect((document.getElementById('y-flip') as HTMLInputElement).checked).toBe(option.input.yFlip);
        expect((document.getElementById('chirality') as HTMLInputElement).checked).toBe(
          option.input.chirality === 'normalize',
        );
        expect((document.getElementById('candidate-mode') as HTMLSelectElement).value).toBe(
          option.input.candidateMode,
        );

        // 押したボタンだけが押された状態になる
        expect(pressedPresets()).toEqual([`${preset.id}:${optionId}`]);

        // 見え方の 1 行はプリセットの文と一致する
        expect(expectationText()).toBe(option.expectation);

        // 流れの表示の 3 つの件数が stub の定義どおりで、1 位が出る
        const scene = demo.getState().scene;
        const expectedFlow = expectedFlowFor(option.input.candidateMode, option.scene);
        expect(flowNumbers().slice(0, 3)).toEqual([
          expectedFlow.candidates,
          expectedFlow.transformed,
          expectedFlow.fitted,
        ]);
        expect(flowText()).toContain(scene.ranked[0].id);
      });
    }
  }

  it('place:b（東京）は東京の真値の行に「真値」が付き、京都の真値の行には付かない', async () => {
    const demo = initDemo({ engine: makeStubEngine() });
    await demo.whenSettled();

    const button = document.querySelector('button[data-preset="place:b"]') as HTMLButtonElement;
    button.dispatchEvent(new Event('click'));
    await demo.whenSettled();

    expect(truthMarkOf(scenes.tokyo.truthId)).toBe('真値');
    // 表に京都の真値の行は在る（候補に含まれる）が、印は付かない
    expect(truthMarkOf(scenes.kyoto.truthId)).toBe('');
    expect(truthMarkOf(scenes.tokyo.truthId)).not.toBe(truthMarkOf(scenes.kyoto.truthId));
  });

  it('選択結果が出た後、Daedalus のデモへのリンクが 1 つだけ在る', async () => {
    const demo = initDemo({ engine: makeStubEngine() });
    await demo.whenSettled();

    const expectedUrl = 'https://code4history.dev/Daedalus/demo/worldfile-fit.html';
    const links = document.querySelectorAll(`a[href="${expectedUrl}"]`);
    expect(links.length).toBe(1);
    expect(document.getElementById('selected-body')?.contains(links[0] as Node)).toBe(true);
  });

  it('選択結果の yScale の符号を「y 上向き／y 下向き」の言葉でも出す', async () => {
    const demo = initDemo({ engine: makeStubEngine() });
    await demo.whenSettled();
    const selected = () => document.getElementById('selected-body')?.textContent ?? '';
    expect(selected()).toContain(Y_SCALE_SIGN_LABELS.positive);

    const checkbox = document.getElementById('y-flip') as HTMLInputElement;
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change'));
    await demo.whenSettled();

    expect(demo.getState().scene.selected.worldFile.yScale).toBeLessThan(0);
    expect(selected()).toContain(Y_SCALE_SIGN_LABELS.negative);
    expect(selected()).not.toContain(Y_SCALE_SIGN_LABELS.positive);
  });
});

describe('流れ・識別力・印・失敗の表示（stub の定義から期待値を決める）', () => {
  beforeEach(() => {
    mountPage();
  });

  it('流れの行の 3 つの件数が stub の定義どおりで、互いに違う値になる', async () => {
    const demo = initDemo({ engine: makeStubEngine() });
    await demo.whenSettled();

    const expected = expectedFlowFor('zones', scenes.kyoto);
    expect(flowNumbers().slice(0, 3)).toEqual([
      expected.candidates,
      expected.transformed,
      expected.fitted,
    ]);
    // 3 つの数が同じ値では、取り違えても気づけない ∴ 全部違うことを明示する
    expect(expected.candidates).not.toBe(expected.transformed);
    expect(expected.transformed).not.toBe(expected.fitted);
    expect(expected.candidates).not.toBe(expected.fitted);
  });

  it('識別力の札に、stub の結果から決まる比の数値が出る', async () => {
    const demo = initDemo({ engine: makeStubEngine() });
    await demo.whenSettled();

    // 反射を吸収しない状態で y を反転すると、どの候補も厳密適合しない ∴ 比が有限の数値になる
    const chirality = document.getElementById('chirality') as HTMLInputElement;
    chirality.checked = false;
    chirality.dispatchEvent(new Event('change'));
    const checkbox = document.getElementById('y-flip') as HTMLInputElement;
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change'));
    await demo.whenSettled();

    const ratio = demo.getState().scene.discrimination.ratio;
    expect(ratio).not.toBeNull();
    expect(Number.isFinite(ratio)).toBe(true);
    expect(ratio).toBeGreaterThan(0);
    expect(discriminationText()).toContain(`識別力 rms[比べた相手]/rms[1位] = ${formatRatioForTest(ratio)}`);
  });

  it('識別力の札に「比べた相手」として stub の正しい候補 ID が出る', async () => {
    const demo = initDemo({ engine: makeStubEngine() });
    await demo.whenSettled();

    expect(discriminationText()).toContain(`比べた相手: ${DISCRIMINATION_AGAINST_ID}`);
    // 比べる相手は 1 位（真値）でも「同値」の行でもない
    expect(DISCRIMINATION_AGAINST_ID).not.toBe(scenes.kyoto.truthId);
    expect(DISCRIMINATION_AGAINST_ID).not.toBe(SAME_DEFINITION_ID);
  });

  it('真値と同じ定義の候補の行に「同値」が付き、真値の行は「真値」、別定義の行には付かない', async () => {
    const demo = initDemo({ engine: makeStubEngine() });
    await demo.whenSettled();

    expect(truthMarkOf(scenes.kyoto.truthId)).toBe('真値');
    expect(truthMarkOf(SAME_DEFINITION_ID)).toBe('同値');
    expect(truthMarkOf(DISCRIMINATION_AGAINST_ID)).toBe('');
  });

  it('推定が失敗したとき、流れの行が「失敗: <理由>（N 件）」になる', async () => {
    const demo = initDemo({ engine: makeFailingEngine() });
    await demo.whenSettled();

    const scene = demo.getState().scene;
    expect(scene.status).toBe('failed');
    expect(scene.failure).not.toBeNull();
    const expected = expectedFlowFor('zones', scenes.kyoto);
    expect(flowText()).toBe(`失敗: ${scene.failure.reason}（${expected.candidates} 件）`);
  });

  it('東京のプリセットでは、真値の投影に東京の場面が渡る', async () => {
    const engine = makeStubEngine();
    const demo = initDemo({ engine });
    await demo.whenSettled();

    const button = document.querySelector('button[data-preset="place:b"]') as HTMLButtonElement;
    button.dispatchEvent(new Event('click'));
    await demo.whenSettled();

    const calls = engine.projectTruth.mock.calls;
    const lastCall = calls[calls.length - 1];
    expect(lastCall?.[1]).toBe(scenes.tokyo);
    expect(lastCall?.[1]?.id).toBe(scenes.tokyo.id);
  });
});

describe('いまの場面の名前を結果の件数の行に出す', () => {
  beforeEach(() => {
    mountPage();
  });

  async function press(presetId: string, optionId: string, demo: ReturnType<typeof initDemo>) {
    const button = document.querySelector(`button[data-preset="${presetId}:${optionId}"]`) as HTMLButtonElement;
    button.dispatchEvent(new Event('click'));
    await demo.whenSettled();
  }

  it('東京のプリセットで東京、つまみを触って中立に戻っても東京のまま、京都のプリセットで京都になる', async () => {
    const demo = initDemo({ engine: makeStubEngine() });
    await demo.whenSettled();
    expect(resultCountText()).toContain(`${scenes.kyoto.label}・候補`);

    await press('place', 'b', demo);
    expect(resultCountText()).toContain(`${scenes.tokyo.label}・候補`);

    // つまみを触るとプリセットの印は消えて中立に戻るが、場面は東京のまま
    const checkbox = document.getElementById('y-flip') as HTMLInputElement;
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change'));
    await demo.whenSettled();
    expect(pressedPresets()).toEqual([]);
    expect(resultCountText()).toContain(`${scenes.tokyo.label}・候補`);

    await press('place', 'a', demo);
    expect(resultCountText()).toContain(`${scenes.kyoto.label}・候補`);
  });
});

describe('手で操作したら中立に戻る（プリセットの印と見え方が消え、計算がもう 1 回だけ走る）', () => {
  beforeEach(() => {
    mountPage();
  });

  async function bootAndPress(presetId: string, optionId: string) {
    const engine = makeStubEngine();
    const demo = initDemo({ engine });
    await demo.whenSettled();
    const button = document.querySelector(`button[data-preset="${presetId}:${optionId}"]`) as HTMLButtonElement;
    button.dispatchEvent(new Event('click'));
    await demo.whenSettled();
    expect(pressedPresets()).toEqual([`${presetId}:${optionId}`]);
    expect(expectationText()).toBe(findPreset(presetId, optionId)!.expectation);
    return { engine, demo };
  }

  function expectNeutral() {
    expect(pressedPresets()).toEqual([]);
    expect(expectationText()).toBe('');
    expect(presetButtons().every((button) => button.getAttribute('aria-pressed') === 'false')).toBe(true);
  }

  it('y の向きのつまみを変えると中立に戻る', async () => {
    const { engine, demo } = await bootAndPress('y-direction', 'b');
    const recalcBefore = demo.getRecalcCount();

    const checkbox = document.getElementById('y-flip') as HTMLInputElement;
    checkbox.checked = false;
    checkbox.dispatchEvent(new Event('change'));
    await demo.whenSettled();

    expect(demo.getRecalcCount()).toBe(recalcBefore + 1);
    expect(engine.loadCandidates).toHaveBeenCalledTimes(2); // 候補は読み直さない
    expectNeutral();
  });

  it('正規化のつまみを変えると中立に戻る（計算は 1 回）', async () => {
    const { demo } = await bootAndPress('normalization', 'a');
    const recalcBefore = demo.getRecalcCount();

    const checkbox = document.getElementById('chirality') as HTMLInputElement;
    checkbox.checked = false;
    checkbox.dispatchEvent(new Event('change'));
    await demo.whenSettled();

    expect(demo.getState().chirality).toBe('direct-only');
    expect(demo.getRecalcCount()).toBe(recalcBefore + 1);
    expectNeutral();
  });

  it('候補の集め方を変えると中立に戻る（計算は 1 回）', async () => {
    const { engine, demo } = await bootAndPress('place', 'a');
    const recalcBefore = demo.getRecalcCount();

    const select = document.getElementById('candidate-mode') as HTMLSelectElement;
    select.value = 'zones';
    select.dispatchEvent(new Event('change'));
    await demo.whenSettled();

    expect(engine.loadCandidates).toHaveBeenCalledTimes(3); // 起動・プリセット・手の操作
    expect(demo.getRecalcCount()).toBe(recalcBefore + 1);
    expectNeutral();
  });

  it('GCP をドラッグすると中立に戻る（計算は離したときに 1 回）', async () => {
    const { demo } = await bootAndPress('place', 'a');
    const recalcBefore = demo.getRecalcCount();

    expect(await dragFirstMarker(demo)).toBe(true);

    expect(demo.getRecalcCount()).toBe(recalcBefore + 1);
    expectNeutral();
  });
});

describe('歴史グリッドの対比（historical-grid）の結線', () => {
  beforeEach(() => {
    mountPage();
  });

  async function bootAndPress(presetId: string, optionId: string) {
    const engine = makeStubEngine();
    const demo = initDemo({ engine });
    await demo.whenSettled();
    const button = document.querySelector(`button[data-preset="${presetId}:${optionId}"]`) as HTMLButtonElement;
    expect(button).not.toBeNull();
    button.dispatchEvent(new Event('click'));
    await demo.whenSettled();
    return { engine, demo };
  }

  it('historical-grid の A・B のボタンが、対比の文言どおりに並ぶ', async () => {
    const demo = initDemo({ engine: makeStubEngine() });
    await demo.whenSettled();

    expect(document.querySelector('button[data-preset="historical-grid:a"]')?.textContent).toBe(
      '現代の地図（VI 系で描いた）',
    );
    expect(document.querySelector('button[data-preset="historical-grid:b"]')?.textContent).toBe(
      '戦前の市街図（歴史グリッド B 帯で描いた）',
    );
  });

  it('A を押すと京都の場面と catalog-custom が engine へ渡り、流れは候補 9 → 変換 8 → 当てはめ 7 になる', async () => {
    const { engine, demo } = await bootAndPress('historical-grid', 'a');

    const loadCall = engine.loadCandidates.mock.calls.at(-1);
    expect(loadCall?.[0]).toBe('catalog-custom');
    expect(loadCall?.[1]?.id).toBe('kyoto');
    const projectCall = engine.projectTruth.mock.calls.at(-1);
    expect(projectCall?.[1]?.id).toBe('kyoto');

    // stub の候補は 6 行 + 歴史グリッド 3 帯 = 9。
    // 変換できない行が 1、当てはめに使えない行が 1 ∴ 9 → 8 → 7（3 つとも違う）。
    expect(flowNumbers().slice(0, 3)).toEqual([9, 8, 7]);
    expect(flowText()).toContain('EPSG:6674');

    // A でも歴史グリッドは変換できている（変換不能の一覧に並ばない）
    expect(demo.getState().scene.untransformableIds).not.toContain('UTJCP:ZONE-B');
    expect(document.getElementById('untransformable')?.textContent ?? '').not.toContain('UTJCP:');
  });

  it('B を押すと kyoto-utjcp の場面と catalog-custom が engine へ渡り、流れは候補 9 → 変換 8 → 当てはめ 7 になる', async () => {
    const { engine, demo } = await bootAndPress('historical-grid', 'b');

    const loadCall = engine.loadCandidates.mock.calls.at(-1);
    expect(loadCall?.[0]).toBe('catalog-custom');
    expect(loadCall?.[1]?.id).toBe('kyoto-utjcp');
    // 場面の範囲と GCP は京都と同じ（値の正本は demo/scenes.js）
    expect(loadCall?.[1]?.extent).toEqual(scenes.kyoto.extent);
    expect(loadCall?.[1]?.gcpLonLat).toEqual(scenes.kyoto.gcpLonLat);
    const projectCall = engine.projectTruth.mock.calls.at(-1);
    expect(projectCall?.[1]?.id).toBe('kyoto-utjcp');

    // stub の候補は 7 行 + 歴史グリッド 2 帯 = 9。
    // 変換できない行が 1、当てはめに使えない行が 1 ∴ 9 → 8 → 7（3 つとも違う）。
    expect(flowNumbers().slice(0, 3)).toEqual([9, 8, 7]);
    expect(flowText()).toContain('UTJCP:ZONE-B');

    expect(demo.getState().scene.untransformableIds).not.toContain('UTJCP:ZONE-B');
    expect(document.getElementById('untransformable')?.textContent ?? '').not.toContain('UTJCP:');
  });

  it('選択結果の world file の値の横に、その候補の単位の名前が出る', async () => {
    const { demo } = await bootAndPress('historical-grid', 'b');
    const scene = demo.getState().scene;

    expect(scene.ranked[0].id).toBe('UTJCP:ZONE-B');
    expect(definitionOf('unit')).toBe('yard (Japan City Plans)');
    // 6 つの値も、その単位のままの数値が出ている
    for (const key of ['xScale', 'ySkew', 'xSkew', 'yScale', 'xOrigin', 'yOrigin']) {
      expect(definitionOf(key)).toBe(formatMetersForTest(scene.selected.worldFile[key]));
    }
    const selectedText = document.getElementById('selected-body')?.textContent ?? '';
    expect(selectedText).toContain('yard (Japan City Plans)');
    expect(selectedText).not.toContain('undefined');
  });

  it('順位の表に単位の列があり、行ごとにその候補の単位が出る', async () => {
    const { demo } = await bootAndPress('historical-grid', 'b');
    const scene = demo.getState().scene;

    const unitColumn = columnIndexOf('単位');
    expect(unitColumn).toBeGreaterThanOrEqual(0);
    expect(cellOf('UTJCP:ZONE-B', unitColumn)).toBe('yard (Japan City Plans)');
    expect(cellOf('EPSG:6674', unitColumn)).toBe('metre');
    // 表の行数は当てはめた件数と一致する
    expect(document.querySelectorAll('#ranked-body tr').length).toBe(scene.ranked.length);
    expect(document.querySelectorAll('#ranked-body tr').length).toBe(7);
  });

  it('1 位と 2 位の rmsMeters が並んで出る（先頭は厳密適合で、2 位はそれより大きい）', async () => {
    const { demo } = await bootAndPress('historical-grid', 'b');
    const scene = demo.getState().scene;

    expect(scene.ranked[0].rmsMeters).toBeLessThan(1e-9);
    expect(scene.ranked[1].rmsMeters).toBeGreaterThan(scene.ranked[0].rmsMeters);
    expect(document.getElementById('top-rms')?.textContent).toBe(
      `1 位 rmsMeters: ${formatMetersForTest(scene.ranked[0].rmsMeters)} / 2 位 rmsMeters: ${formatMetersForTest(
        scene.ranked[1].rmsMeters,
      )}`,
    );
  });
});

describe('ページの起動', () => {
  beforeEach(() => {
    mountPage();
  });

  it('ページが main.js を読み、body に自動起動の合図を持つ', () => {
    expect(/<body[^>]*\sdata-demo-auto-init="true"/i.test(pageHtml)).toBe(true);
    expect(pageHtml).toContain('<script type="module" src="./main.js"></script>');
  });

  it('合図があるときだけ initDemo が起動する', async () => {
    const before = autoInitStub.loadCandidatesCalls;
    document.body.dataset.demoAutoInit = 'true';
    vi.resetModules();
    await import('../demo/main.js');

    await vi.waitFor(() => expect(autoInitStub.loadCandidatesCalls).toBeGreaterThan(before));
    expect(document.querySelectorAll('#preset-bar button[data-preset]').length).toBe(
      PRESETS.length * PRESET_OPTION_IDS.length,
    );
  });

  it('合図が無ければ起動しない', async () => {
    const before = autoInitStub.loadCandidatesCalls;
    delete document.body.dataset.demoAutoInit;
    vi.resetModules();
    await import('../demo/main.js');

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(autoInitStub.loadCandidatesCalls).toBe(before);
  });
});
