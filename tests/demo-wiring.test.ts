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

import { initDemo } from '../demo/main.js';
import { GCP_LONLAT } from '../demo/estimate-scene.js';

// ---------------------------------------------------------------------------
// stub engine（決定的。実 proj-wasm を使わない）
// ---------------------------------------------------------------------------

const LON0 = 135.75;
const LAT0 = 35.0;
const SCALE = 100_000;

/**
 * 候補 3 件。真値だけが**等方スケール**（= 相似変換で厳密適合する）であり、他の 2 件は
 * わずかに非等方である ∴
 *   - 反射なし … 真値 rms = 0 → 比は Infinity（識別できている）
 *   - 反射あり … 3 件とも反射由来の巨大残差に支配され、差は `1e-3` 相対 → 比は 1.0x（潰れる）
 * これは実 engine で観測される現象（`1.000199…`）と**同じ構造**である。
 */
const STUB_CANDIDATES = [
  { id: 'EPSG:6674', authority: 'EPSG', code: '6674', sx: SCALE, sy: SCALE },
  { id: 'EPSG:6673', authority: 'EPSG', code: '6673', sx: SCALE, sy: SCALE * (1 + 1e-3) },
  { id: 'EPSG:6675', authority: 'EPSG', code: '6675', sx: SCALE * (1 + 2e-3), sy: SCALE },
];

function projectWith(row: (typeof STUB_CANDIDATES)[number], points: ReadonlyArray<readonly [number, number]>) {
  return points.map(([lon, lat]): [number, number] => [(lon - LON0) * row.sx, (lat - LAT0) * row.sy]);
}

function makeStubEngine() {
  const loadCandidates = vi.fn(async (mode: string) =>
    mode === 'zones' ? STUB_CANDIDATES : [...STUB_CANDIDATES, { id: 'EPSG:3094', authority: 'EPSG', code: '3094', sx: SCALE * 1.5, sy: SCALE * 1.5 }],
  );
  return {
    loadEngine: vi.fn(async () => true),
    loadCandidates,
    makeTransformer: vi.fn((rows: typeof STUB_CANDIDATES) => {
      const byId = new Map(rows.map((row) => [row.id, row]));
      return (id: string, points: ReadonlyArray<readonly [number, number]>, geoBasis: { kind: string; axisOrder: string }) => {
        if (geoBasis.kind !== 'lonlat_deg' || geoBasis.axisOrder !== 'lon-lat') return null;
        const target = byId.get(id);
        if (target === undefined) return null;
        return projectWith(target, points);
      };
    }),
    projectTruth: vi.fn(async (rows: typeof STUB_CANDIDATES) =>
      projectWith(rows.find((row) => row.id === 'EPSG:6674')!, GCP_LONLAT as ReadonlyArray<readonly [number, number]>),
    ),
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

  it('(d) #ranked-body の行数が ranked.length と一致する', async () => {
    const engine = makeStubEngine();
    const demo = initDemo({ engine });
    await demo.whenSettled();

    const rows = document.querySelectorAll('#ranked-body tr');
    expect(rows.length).toBe(demo.getState().scene.ranked.length);
    expect(rows.length).toBe(STUB_CANDIDATES.length);
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

  it('(e) y 反転で識別力が潰れ、「識別力が潰れている」バッジが出る', async () => {
    const engine = makeStubEngine();
    const demo = initDemo({ engine });
    await demo.whenSettled();

    const discrimination = document.getElementById('discrimination') as HTMLElement;
    expect(discrimination.textContent).toContain('識別できている');
    expect(discrimination.querySelector('.teiresias-badge-collapsed')).toBeNull();

    const checkbox = document.getElementById('y-flip') as HTMLInputElement;
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change'));
    await demo.whenSettled();

    expect(demo.getState().scene.discrimination.collapsed).toBe(true);
    expect(discrimination.textContent).toContain('識別力が潰れている');
    expect(discrimination.querySelector('.teiresias-badge-collapsed')).not.toBeNull();
  });

  it('(b) #candidate-mode の change で候補モードが engine へ渡る', async () => {
    const engine = makeStubEngine();
    const demo = initDemo({ engine });
    await demo.whenSettled();
    expect(engine.loadCandidates).toHaveBeenCalledWith('zones');

    const select = document.getElementById('candidate-mode') as HTMLSelectElement;
    select.value = 'catalog';
    select.dispatchEvent(new Event('change'));
    await demo.whenSettled();

    expect(engine.loadCandidates).toHaveBeenCalledTimes(2);
    expect(engine.loadCandidates).toHaveBeenLastCalledWith('catalog');
    expect(demo.getState().candidateMode).toBe('catalog');
    expect(document.querySelectorAll('#ranked-body tr').length).toBe(4);
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
