/**
 * デモの DOM 結線層（m3-t1 設計 v1.3 §5.4）。
 *
 * **計算を書かない。** 計算は `estimate-scene.js`（純関数）、engine 接続は
 * `atlas-engine.js` にある。本ファイルは `engine` を**注入**で受け取り、既定値だけを
 * `atlas-engine.js` に置く（`estimateCrs` が transformer を注入で受けるのと同型）。
 *
 * ## 本ファイルに課された 2 つの構造要件（設計 §5.4）
 *
 * **(1) canvas 2D コンテキストの null 耐性（K21 / m3-t1/AC-6(f)）**
 * jsdom は canvas 2D を実装しない ∴ `getContext('2d')` は `null` を返す。
 * 初期化・計算・表結線・イベント結線は **ctx が null でも最後まで完了する**。
 * 描画関数は先頭で `if (!ctx) return;` する（呼出側に条件分岐を撒かない）。
 * ヒットテストは ctx に依存させず `getBoundingClientRect()` と数値座標で行う。
 * **テスト側で `getContext` を stub する道は採らない**（採ると AC-6(f) を検査したことに
 * ならない）。これは `Atlas/demo/main.js:166-167`（無条件に取得する）からの意図的な逸脱である。
 *
 * **(2) DOM 挿入は `textContent` / DOM API のみ（K20 / m3-t1/AC-7）**
 * outer の sink 走査（`scripts/m1-t4/verify-html-sinks.mjs`）は `REPOS` に Teiresias を
 * 持たず、走査サブディレクトリにも `demo` が無い ∴ **本ファイルはどの sink 走査にも
 * 覆われない**。走査で守れない分を構成で守る — **HTML 文字列を直接 DOM へ流し込む
 * 3 種の sink API を 1 箇所も使わない**（禁止対象の名前は `tests/publish-and-demo.test.ts`
 * の needle 表が正本である。ここに literal で書くと、その assert が自分自身を検出して
 * 常に RED になる — `tests/package-shape.test.ts` が needle を断片から組み立てて
 * 避けているのと同型の罠である）。
 */
import * as defaultEngine from './atlas-engine.js';
import {
  GCP_LONLAT,
  METERS_PER_PIXEL,
  TRUE_ID,
  applyYFlip,
  basePixelsFromProjected,
  runScene,
} from './estimate-scene.js';

const BOARD_WIDTH = 380;
const BOARD_HEIGHT = 300;
/** マーカーを掴んだと見なす距離（board 座標 px）。 */
const GRAB_RADIUS = 12;

const COLOR = {
  marker: '#c0392b',
  markerTruth: '#3a7bd5',
  outline: '#ffffff',
  frame: '#8aadcc',
  grid: '#dfe6ee',
};

// ---------------------------------------------------------------------------
// 座標変換（純粋な数値計算。DOM に依存しない）
// ---------------------------------------------------------------------------

/**
 * データ座標 → board 座標の対応を作る。
 *
 * `bounds` は `{minX, minY, maxX, maxY}`。データの y は上向き、board の y は下向き ∴
 * y だけ反転する。
 */
function makeMapper(bounds) {
  const spanX = bounds.maxX - bounds.minX || 1;
  const spanY = bounds.maxY - bounds.minY || 1;
  const scale = Math.min((BOARD_WIDTH - 40) / spanX, (BOARD_HEIGHT - 40) / spanY);
  const offsetX = (BOARD_WIDTH - spanX * scale) / 2;
  const offsetY = (BOARD_HEIGHT - spanY * scale) / 2;

  return {
    toBoard([x, y]) {
      return [
        offsetX + (x - bounds.minX) * scale,
        BOARD_HEIGHT - offsetY - (y - bounds.minY) * scale,
      ];
    },
    toData([bx, by]) {
      return [
        bounds.minX + (bx - offsetX) / scale,
        bounds.minY + (BOARD_HEIGHT - offsetY - by) / scale,
      ];
    },
  };
}

function geoBounds(geoPoints) {
  const lons = geoPoints.map((point) => point[0]);
  const lats = geoPoints.map((point) => point[1]);
  const padLon = (Math.max(...lons) - Math.min(...lons)) * 0.15 || 0.01;
  const padLat = (Math.max(...lats) - Math.min(...lats)) * 0.15 || 0.01;
  return {
    minX: Math.min(...lons) - padLon,
    maxX: Math.max(...lons) + padLon,
    minY: Math.min(...lats) - padLat,
    maxY: Math.max(...lats) + padLat,
  };
}

/**
 * pixel 板の視野。**y を原点対称に取る**（y 反転しても図形が視野から外れないため）。
 * 視野は base pixel から 1 回だけ決め、ドラッグのたびに変えない（図が跳ねないため）。
 */
function pixelBounds(basePixels) {
  const xs = basePixels.map((point) => point[0]);
  const ys = basePixels.map((point) => point[1]);
  const maxAbsY = Math.max(...ys.map(Math.abs), 1);
  const padX = (Math.max(...xs) - Math.min(...xs)) * 0.3 || 1;
  return {
    minX: Math.min(...xs) - padX,
    maxX: Math.max(...xs) + padX,
    minY: -maxAbsY * 1.35,
    maxY: maxAbsY * 1.35,
  };
}

// ---------------------------------------------------------------------------
// 描画（ctx が null なら何もしない）
// ---------------------------------------------------------------------------

function drawBoard(ctx, points, mapper, options) {
  if (!ctx) return;
  ctx.clearRect(0, 0, BOARD_WIDTH, BOARD_HEIGHT);

  ctx.save();
  ctx.strokeStyle = COLOR.grid;
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, BOARD_WIDTH - 1, BOARD_HEIGHT - 1);
  ctx.restore();

  if (points.length > 1) {
    ctx.save();
    ctx.strokeStyle = COLOR.frame;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    points.forEach((point, index) => {
      const [bx, by] = mapper.toBoard(point);
      if (index === 0) ctx.moveTo(bx, by);
      else ctx.lineTo(bx, by);
    });
    ctx.closePath();
    ctx.stroke();
    ctx.restore();
  }

  points.forEach((point, index) => {
    const [bx, by] = mapper.toBoard(point);
    ctx.save();
    ctx.fillStyle = index === options.activeIndex ? COLOR.markerTruth : COLOR.marker;
    ctx.strokeStyle = COLOR.outline;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(bx, by, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  });
}

// ---------------------------------------------------------------------------
// 数値の整形
// ---------------------------------------------------------------------------

function formatMeters(value) {
  if (!Number.isFinite(value)) return String(value);
  if (value === 0) return '0';
  if (Math.abs(value) < 1e-3 || Math.abs(value) >= 1e5) return value.toExponential(4);
  return value.toFixed(4);
}

function formatRatio(ratio) {
  if (ratio === null) return '—';
  if (!Number.isFinite(ratio)) return '∞';
  if (ratio >= 1e4) return ratio.toExponential(4);
  return ratio.toFixed(6);
}

// ---------------------------------------------------------------------------
// 本体
// ---------------------------------------------------------------------------

/**
 * デモを初期化する。
 *
 * @param {{engine?: object, doc?: Document}} [config]
 *   `engine` は `atlas-engine.js` と同じ 4 関数（`loadEngine` / `loadCandidates` /
 *   `makeTransformer` / `projectTruth`）を持つオブジェクト。テストは stub を注入する。
 * @returns {{whenSettled: () => Promise<void>, getRecalcCount: () => number,
 *            getState: () => object}} 観測用ハンドル（テストが再計算回数を直接数えるため）。
 */
export function initDemo(config = {}) {
  const engine = config.engine ?? defaultEngine;
  const doc = config.doc ?? document;

  const el = {
    status: doc.getElementById('status'),
    note: doc.getElementById('note'),
    error: doc.getElementById('error'),
    yFlip: doc.getElementById('y-flip'),
    candidateMode: doc.getElementById('candidate-mode'),
    resetGcp: doc.getElementById('reset-gcp'),
    geoCanvas: doc.getElementById('geo-canvas'),
    pixelCanvas: doc.getElementById('pixel-canvas'),
    discrimination: doc.getElementById('discrimination'),
    resultCount: doc.getElementById('result-count'),
    rankedBody: doc.getElementById('ranked-body'),
    selectedBody: doc.getElementById('selected-body'),
    untransformable: doc.getElementById('untransformable'),
  };

  // ctx は null でありうる（jsdom は canvas 2D を実装しない）。
  // 以後この 2 つは描画関数へ渡すだけであり、初期化・計算・結線は ctx に依存しない。
  const geoCtx = el.geoCanvas?.getContext ? el.geoCanvas.getContext('2d') : null;
  const pixelCtx = el.pixelCanvas?.getContext ? el.pixelCanvas.getContext('2d') : null;

  const state = {
    geoPoints: GCP_LONLAT.map((point) => [point[0], point[1]]),
    basePixels: [],
    pixels: [],
    yFlip: false,
    candidateMode: 'zones',
    candidates: [],
    transformer: null,
    scene: null,
    dragIndex: null,
    ready: false,
    running: false,
    pending: false,
    recalcCount: 0,
    settled: Promise.resolve(),
  };

  let geoMapper = makeMapper(geoBounds(state.geoPoints));
  let pixelMapper = makeMapper({ minX: -1, maxX: 1, minY: -1, maxY: 1 });

  // -- 表示 ---------------------------------------------------------------

  function setText(node, text) {
    if (node) node.textContent = text;
  }

  function clearChildren(node) {
    if (!node) return;
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function appendCell(row, text, className) {
    const cell = doc.createElement('td');
    cell.textContent = text;
    if (className) cell.className = className;
    row.appendChild(cell);
  }

  function renderRanked(scene) {
    clearChildren(el.rankedBody);
    if (!el.rankedBody || !scene) return;
    for (const entry of scene.ranked) {
      const row = doc.createElement('tr');
      if (entry.isTruth) row.className = 'teiresias-truth-row';
      appendCell(row, String(entry.rank));
      appendCell(row, entry.id);
      appendCell(row, entry.score === null ? '—' : entry.score.toFixed(6));
      appendCell(row, formatMeters(entry.rmsMeters));
      appendCell(row, entry.isTruth ? '真値' : '');
      el.rankedBody.appendChild(row);
    }
  }

  function appendDefinition(list, term, description) {
    const dt = doc.createElement('dt');
    dt.textContent = term;
    const dd = doc.createElement('dd');
    dd.textContent = description;
    list.appendChild(dt);
    list.appendChild(dd);
  }

  function renderSelected(scene) {
    clearChildren(el.selectedBody);
    if (!el.selectedBody || !scene) return;
    const list = doc.createElement('dl');
    list.className = 'teiresias-definition-list';
    if (scene.selected === null) {
      appendDefinition(list, 'selected', 'なし（採用候補が決まらなかった）');
    } else {
      const { identity, worldFile, qualityGate, rmsMeters, score } = scene.selected;
      appendDefinition(list, 'identity', `${identity.authority}:${identity.code}`);
      appendDefinition(list, 'qualityGate', String(qualityGate));
      appendDefinition(list, 'score', score === null ? '—' : score.toFixed(6));
      appendDefinition(list, 'rmsMeters', formatMeters(rmsMeters));
      // `@c4h/daedalus` の WorldFile の実キー（実測: Daedalus/src/types.ts:3-10）。
      // world file の行順（xScale / ySkew / xSkew / yScale / xOrigin / yOrigin）で並べる。
      for (const key of ['xScale', 'ySkew', 'xSkew', 'yScale', 'xOrigin', 'yOrigin']) {
        appendDefinition(list, key, formatMeters(worldFile[key]));
      }
    }
    appendDefinition(list, 'status', String(scene.status));
    el.selectedBody.appendChild(list);
  }

  function renderDiscrimination(scene) {
    clearChildren(el.discrimination);
    if (!el.discrimination || !scene) return;
    const { ratio, collapsed } = scene.discrimination;

    const badge = doc.createElement('span');
    badge.className = collapsed ? 'c4h-badge teiresias-badge-collapsed' : 'c4h-badge';
    badge.textContent =
      collapsed === null ? '判定不能（候補が 1 件以下）' : collapsed ? '識別力が潰れている' : '識別できている';
    el.discrimination.appendChild(badge);

    const text = doc.createElement('span');
    text.className = 'teiresias-discrimination-text';
    text.textContent = ` 識別力 rms[2位]/rms[1位] = ${formatRatio(ratio)}`;
    el.discrimination.appendChild(text);
  }

  function renderBoards() {
    const effective = applyYFlip(state.pixels, state.yFlip);
    drawBoard(geoCtx, state.geoPoints, geoMapper, { activeIndex: state.dragIndex });
    drawBoard(pixelCtx, effective, pixelMapper, { activeIndex: state.dragIndex });
  }

  function renderScene(scene) {
    renderRanked(scene);
    renderSelected(scene);
    renderDiscrimination(scene);
    setText(
      el.resultCount,
      scene ? `候補 ${scene.ranked.length} 件（モード: ${state.candidateMode}）` : '未計算',
    );
    setText(
      el.untransformable,
      scene && scene.untransformableIds.length > 0
        ? `変換不能: ${scene.untransformableIds.join(', ')}`
        : '',
    );
    setText(
      el.note,
      scene && scene.warnings.length > 0
        ? `警告: ${scene.warnings.map((warning) => warning.code ?? String(warning)).join(', ')}`
        : '',
    );
  }

  // -- 計算 ---------------------------------------------------------------

  async function recalculate() {
    if (state.running) {
      state.pending = true;
      return;
    }
    state.running = true;
    setText(el.status, '計算中...');
    try {
      const scene = await runScene({
        pixels: state.pixels,
        geoPoints: state.geoPoints,
        yFlip: state.yFlip,
        candidates: state.candidates,
        transformer: state.transformer,
      });
      state.scene = scene;
      state.recalcCount += 1;
      renderScene(scene);
      renderBoards();
      setText(el.error, '');
      setText(el.status, `計算完了（候補 ${scene.ranked.length} 件）`);
    } catch (error) {
      setText(el.error, error instanceof Error ? error.message : String(error));
      setText(el.status, '計算に失敗しました');
    } finally {
      state.running = false;
      if (state.pending) {
        state.pending = false;
        await recalculate();
      }
    }
  }

  function schedule() {
    state.settled = state.settled.then(() => recalculate());
    return state.settled;
  }

  async function loadCandidatesAndRecalculate() {
    try {
      state.candidates = await engine.loadCandidates(state.candidateMode);
      state.transformer = engine.makeTransformer(state.candidates);
    } catch (error) {
      setText(el.error, error instanceof Error ? error.message : String(error));
      setText(el.status, '候補カタログの取得に失敗しました');
      return;
    }
    await recalculate();
  }

  function scheduleCandidateReload() {
    state.settled = state.settled.then(() => loadCandidatesAndRecalculate());
    return state.settled;
  }

  // -- ドラッグ（ctx に依存しない。getBoundingClientRect と数値座標だけ） ----

  function boardPointFromEvent(event) {
    const canvas = el.pixelCanvas;
    if (!canvas || typeof canvas.getBoundingClientRect !== 'function') return null;
    const rect = canvas.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return null;
    return [
      ((event.clientX - rect.left) / rect.width) * BOARD_WIDTH,
      ((event.clientY - rect.top) / rect.height) * BOARD_HEIGHT,
    ];
  }

  function findNearestMarker(boardPoint) {
    const effective = applyYFlip(state.pixels, state.yFlip);
    let bestIndex = null;
    let bestDistance = GRAB_RADIUS;
    effective.forEach((point, index) => {
      const [bx, by] = pixelMapper.toBoard(point);
      const distance = Math.hypot(bx - boardPoint[0], by - boardPoint[1]);
      if (distance <= bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    });
    return bestIndex;
  }

  function onPointerDown(event) {
    if (!state.ready) return;
    const boardPoint = boardPointFromEvent(event);
    if (boardPoint === null) return;
    const index = findNearestMarker(boardPoint);
    if (index === null) return;
    state.dragIndex = index;
    if (typeof el.pixelCanvas.setPointerCapture === 'function' && event.pointerId !== undefined) {
      el.pixelCanvas.setPointerCapture(event.pointerId);
    }
    setText(el.status, 'ドラッグ中（離すと再計算）');
    renderBoards();
  }

  function onPointerMove(event) {
    if (state.dragIndex === null) return;
    const boardPoint = boardPointFromEvent(event);
    if (boardPoint === null) return;
    const [x, y] = pixelMapper.toData(boardPoint);
    // 画面上は反転後の座標を触っている ∴ 保持する値へ戻すときに反転を解く。
    state.pixels[state.dragIndex] = [x, state.yFlip ? -y : y];
    renderBoards();
  }

  function onPointerUp() {
    if (state.dragIndex === null) return;
    state.dragIndex = null;
    renderBoards();
    void schedule();
  }

  // -- 結線（ctx が null でも必ず最後まで通る） ----------------------------

  function bindControls() {
    el.yFlip?.addEventListener('change', () => {
      state.yFlip = Boolean(el.yFlip.checked);
      renderBoards();
      void schedule();
    });

    el.candidateMode?.addEventListener('change', () => {
      state.candidateMode = el.candidateMode.value;
      void scheduleCandidateReload();
    });

    el.resetGcp?.addEventListener('click', () => {
      state.pixels = state.basePixels.map((point) => [point[0], point[1]]);
      renderBoards();
      void schedule();
    });

    el.pixelCanvas?.addEventListener('pointerdown', onPointerDown);
    el.pixelCanvas?.addEventListener('pointermove', onPointerMove);
    el.pixelCanvas?.addEventListener('pointerup', onPointerUp);
    el.pixelCanvas?.addEventListener('pointercancel', onPointerUp);
  }

  async function boot() {
    setText(el.status, '初期化中...');
    bindControls();
    renderBoards();
    try {
      await engine.loadEngine();
      state.candidateMode = el.candidateMode?.value ?? state.candidateMode;
      state.yFlip = Boolean(el.yFlip?.checked);
      state.candidates = await engine.loadCandidates(state.candidateMode);
      state.transformer = engine.makeTransformer(state.candidates);
      const projected = await engine.projectTruth(state.candidates);
      state.basePixels = basePixelsFromProjected(projected, METERS_PER_PIXEL);
      state.pixels = state.basePixels.map((point) => [point[0], point[1]]);
      pixelMapper = makeMapper(pixelBounds(state.basePixels));
      state.ready = true;
      renderBoards();
      await recalculate();
    } catch (error) {
      setText(el.error, error instanceof Error ? error.message : String(error));
      setText(el.status, '初期化に失敗しました');
    }
  }

  state.settled = boot();

  return {
    whenSettled: () => state.settled,
    getRecalcCount: () => state.recalcCount,
    getState: () => ({
      yFlip: state.yFlip,
      candidateMode: state.candidateMode,
      pixels: state.pixels.map((point) => [point[0], point[1]]),
      basePixels: state.basePixels.map((point) => [point[0], point[1]]),
      ready: state.ready,
      truthId: TRUE_ID,
      hasContext: { geo: geoCtx !== null, pixel: pixelCtx !== null },
      scene: state.scene,
    }),
  };
}

/**
 * 自動起動は**ページ側が明示的に要求したときだけ**行う。
 *
 * `demo/crs-estimate-ranking.html` の `<body data-demo-auto-init="true">` が唯一の合図で
 * ある。DOM の有無で判定すると、jsdom テストが DOM を組んだ状態で本モジュールを import した
 * 瞬間に**実 engine で**起動してしまう ∴ 合図をページ側に持たせて注入経路を塞がない。
 */
if (typeof document !== 'undefined' && document.body?.dataset?.demoAutoInit === 'true') {
  initDemo();
}
