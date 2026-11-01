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
  METERS_PER_PIXEL,
  applyYFlip,
  basePixelsFromProjected,
  runScene,
} from './estimate-scene.js';
import { PRESETS, PRESET_OPTION_IDS, findPreset } from './presets.js';
import { DAEDALUS_DEMO_URL, DEFAULT_SCENE } from './scenes.js';

const BOARD_WIDTH = 380;
const BOARD_HEIGHT = 300;
/** マーカーを掴んだと見なす距離（board 座標 px）。 */
const GRAB_RADIUS = 12;

/**
 * `yScale` の符号を言葉で出すときの文言（画面とテストが同じ定数を使う）。
 * 正の `yScale` は pixel の y が上向き、負は下向き（スキャンした地図の向き）である。
 */
export const Y_SCALE_SIGN_LABELS = Object.freeze({
  positive: 'y 上向き',
  negative: 'y 下向き',
});

/**
 * ビルド時に焼き込む 3 つの package の版（`vite.config.ts` の `define`）。
 * dev server と Pages のビルドで同じ値になる。素の状態（テストなど）では未定義 ∴ 表示しない。
 */
const VERSIONS =
  typeof __C4H_VERSIONS__ === 'object' && __C4H_VERSIONS__ !== null ? __C4H_VERSIONS__ : null;

/** フッタに出す「使っている版」の 1 行。 */
function versionsLine(versions) {
  if (!versions) return '';
  return `使っている版: @c4h/atlas ${versions.atlas}・@c4h/daedalus ${versions.daedalus}・@c4h/teiresias ${versions.teiresias}`;
}

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

/**
 * `#chirality`（反射を吸収する）の状態を `estimateCrs` の `chirality` へ写す。
 * チェックボックスが無いページでは既定（正規化あり）にする。
 */
function chiralityFromCheckbox(checkbox) {
  if (!checkbox) return 'normalize';
  return checkbox.checked ? 'normalize' : 'direct-only';
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
    presetBar: doc.getElementById('preset-bar'),
    presetExpectation: doc.getElementById('preset-expectation'),
    flow: doc.getElementById('flow'),
    version: doc.getElementById('version'),
    yFlip: doc.getElementById('y-flip'),
    chirality: doc.getElementById('chirality'),
    candidateMode: doc.getElementById('candidate-mode'),
    resetGcp: doc.getElementById('reset-gcp'),
    geoCanvas: doc.getElementById('geo-canvas'),
    pixelCanvas: doc.getElementById('pixel-canvas'),
    discrimination: doc.getElementById('discrimination'),
    topRms: doc.getElementById('top-rms'),
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
    // 場面（`demo/scenes.js`）。プリセットで入れ替わる。GCP は場面が持つので、ここには持たない。
    place: DEFAULT_SCENE,
    // 直近の計算結果（`runScene` の返り値）。
    result: null,
    geoPoints: DEFAULT_SCENE.gcpLonLat.map((point) => [point[0], point[1]]),
    basePixels: [],
    pixels: [],
    yFlip: false,
    chirality: 'normalize',
    candidateMode: 'zones',
    candidates: [],
    transformer: null,
    /** 押されているプリセット（`"<対比の名前>:<a|b>"`）。手で触ると `null` に戻る（中立）。 */
    activePreset: null,
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
      appendCell(row, entry.isTruth ? '真値' : entry.isSameDefinition ? '同値' : '');
      // その候補の座標の単位（metre でない候補は世界測地系と違う単位で world file が出る）。
      appendCell(row, entry.unit?.name ?? '');
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
      // 6 値はその候補の座標の単位で書かれている ∴ 単位を値の隣に出す。
      appendDefinition(list, 'unit', scene.selected.unit.name);
      // `yScale` の符号は「画像の y がどちら向きか」である ∴ 数に加えて言葉でも出す。
      appendDefinition(
        list,
        'y の向き',
        worldFile.yScale > 0 ? Y_SCALE_SIGN_LABELS.positive : Y_SCALE_SIGN_LABELS.negative,
      );
    }
    appendDefinition(list, 'status', String(scene.status));
    el.selectedBody.appendChild(list);

    // world file の当てはめのパネルは Daedalus のデモにある ∴ ここではそのデモへ渡す。
    const daedalusLink = doc.createElement('a');
    daedalusLink.className = 'teiresias-external-link';
    daedalusLink.href = DAEDALUS_DEMO_URL;
    daedalusLink.target = '_blank';
    daedalusLink.rel = 'noreferrer noopener';
    daedalusLink.textContent = 'Daedalus のデモで見る';
    el.selectedBody.appendChild(daedalusLink);
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
    text.textContent = ` 識別力 rms[比べた相手]/rms[1位] = ${formatRatio(ratio)}`;
    el.discrimination.appendChild(text);

    // 比べた相手。同じ定義の候補（真値の縮退クラス）は 1 つと数えるので、2 位とは限らない。
    if (scene.discrimination.against !== null && scene.discrimination.against !== undefined) {
      const against = doc.createElement('span');
      against.className = 'teiresias-discrimination-against';
      against.textContent = ` 比べた相手: ${scene.discrimination.against}`;
      el.discrimination.appendChild(against);
    }
  }

  /**
   * 1 位と**比べた相手**（1 位と定義が違う最初の候補）の `rmsMeters` を並べて出す。
   *
   * 相手は識別力の札と同じ `discrimination.against` を使う（同じ定義を 2 か所で実装しない）。
   * 残差は metre で比べられる（単位が違う候補でも同じ土俵）。差が小さいことは隠さず、数で出す。
   * 比べた相手が無い（`against` が null）ときは相手の側を「—」にする。
   */
  function topRmsLineOf(scene) {
    if (!scene || scene.ranked.length === 0) return '';
    const first = scene.ranked[0];
    const { against, top2Rms } = scene.discrimination;
    const opponent =
      against === null || against === undefined ? '—' : `${against} rmsMeters: ${formatMeters(top2Rms)}`;
    return `1 位 ${first.id} rmsMeters: ${formatMeters(first.rmsMeters)} / 比べた相手 ${opponent}`;
  }

  /**
   * 流れの表示の 1 行（Atlas → Daedalus → Teiresias）。件数は実行時の値である。
   * 推定が失敗したときは 1 位の代わりに理由と件数を出す。
   */
  function flowLineOf(scene, candidateCount) {
    if (scene.status === 'failed' && scene.failure) {
      return `失敗: ${scene.failure.reason}（${scene.failure.candidates.length} 件）`;
    }
    const transformed = candidateCount - scene.untransformableIds.length;
    const top = scene.ranked[0]?.id ?? '—';
    return `Atlas: 候補 ${candidateCount} 件 → 変換できた ${transformed} 件 → Daedalus: 当てはめ ${scene.ranked.length} 件 → Teiresias: 1 位 ${top}`;
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
    setText(el.topRms, topRmsLineOf(scene));
    setText(el.flow, scene ? flowLineOf(scene, state.candidates.length) : '');
    setText(
      el.resultCount,
      scene
        ? `${state.place.label}・候補 ${scene.ranked.length} 件（モード: ${state.candidateMode}）`
        : '未計算',
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
        chirality: state.chirality,
        candidates: state.candidates,
        transformer: state.transformer,
        scene: state.place,
      });
      state.result = scene;
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
      state.candidates = await engine.loadCandidates(state.candidateMode, state.place);
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

  /**
   * 場面の入力（GCP・真値の投影座標から作る pixel 格子・候補）を読み直す。
   * 場面が変わると GCP も pixel 格子も変わる ∴ 4 つを一度に入れ替える。
   */
  async function loadPlaceInputs() {
    const place = state.place;
    state.geoPoints = place.gcpLonLat.map((point) => [point[0], point[1]]);
    geoMapper = makeMapper(geoBounds(state.geoPoints));
    state.candidates = await engine.loadCandidates(state.candidateMode, place);
    state.transformer = engine.makeTransformer(state.candidates);
    const projected = await engine.projectTruth(state.candidates, place);
    state.basePixels = basePixelsFromProjected(projected, METERS_PER_PIXEL);
    state.pixels = state.basePixels.map((point) => [point[0], point[1]]);
    pixelMapper = makeMapper(pixelBounds(state.basePixels));
  }

  async function loadPlaceAndRecalculate() {
    try {
      await loadPlaceInputs();
    } catch (error) {
      setText(el.error, error instanceof Error ? error.message : String(error));
      setText(el.status, '候補カタログの取得に失敗しました');
      return;
    }
    renderBoards();
    await recalculate();
  }

  // -- プリセットの帯 ------------------------------------------------------

  /** つまみ（チェック・選択）の表示を状態へ合わせる。プリセットを押したときに使う。 */
  function syncControls() {
    if (el.yFlip) el.yFlip.checked = state.yFlip;
    if (el.chirality) el.chirality.checked = state.chirality === 'normalize';
    if (el.candidateMode) el.candidateMode.value = state.candidateMode;
  }

  /** 押されているボタンだけに `aria-pressed="true"` を付す。 */
  function markPressed(activeId) {
    if (!el.presetBar) return;
    for (const button of el.presetBar.querySelectorAll('button[data-preset]')) {
      const pressed = button.dataset.preset === activeId;
      button.setAttribute('aria-pressed', String(pressed));
      button.classList.toggle('active', pressed);
    }
  }

  /**
   * 手で入力を変えたら中立へ戻す。押した印と「見え方」の 1 行は、いま画面に出ている入力とは
   * もう一致しない ∴ 消す（プリセットは入口であって、操作を縛らない）。
   */
  function leavePreset() {
    if (state.activePreset === null) return;
    state.activePreset = null;
    markPressed(null);
    setText(el.presetExpectation, '');
  }

  /** プリセットを 1 つ適用する。入力（場面・候補の集め方・y の向き・正規化）を一度に入れ、計算は 1 回。 */
  async function applyPreset(presetId, optionId) {
    const option = findPreset(presetId, optionId);
    if (option === undefined) return;
    state.activePreset = `${presetId}:${optionId}`;
    state.place = option.scene;
    state.candidateMode = option.input.candidateMode;
    state.yFlip = option.input.yFlip;
    state.chirality = option.input.chirality;
    syncControls();
    markPressed(state.activePreset);
    setText(el.presetExpectation, option.expectation);
    await loadPlaceAndRecalculate();
  }

  function schedulePreset(presetId, optionId) {
    state.settled = state.settled.then(() => applyPreset(presetId, optionId));
    return state.settled;
  }

  /** 帯を組む（対比ごとに A・B の 2 つのボタン）。文言と入力は `demo/presets.js` が持つ。 */
  function renderPresetBar() {
    if (!el.presetBar) return;
    clearChildren(el.presetBar);
    for (const preset of PRESETS) {
      const group = doc.createElement('div');
      group.className = 'teiresias-preset-group';
      for (const optionId of PRESET_OPTION_IDS) {
        const option = findPreset(preset.id, optionId);
        if (option === undefined) continue;
        const button = doc.createElement('button');
        button.type = 'button';
        button.className = 'teiresias-preset-btn';
        button.dataset.preset = `${preset.id}:${optionId}`;
        button.textContent = option.label;
        button.setAttribute('aria-pressed', 'false');
        button.addEventListener('click', () => void schedulePreset(preset.id, optionId));
        group.appendChild(button);
      }
      el.presetBar.appendChild(group);
    }
  }

  /** フッタの「使っている版」。ビルド時に焼き込んだ値（dev でも同じ値）を出す。 */
  function renderVersion() {
    setText(el.version, versionsLine(VERSIONS));
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
    // GCP を手で動かしたのはプリセットの入力ではない ∴ 中立へ戻す（計算は離したときに 1 回）。
    leavePreset();
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
      leavePreset();
      state.yFlip = Boolean(el.yFlip.checked);
      renderBoards();
      void schedule();
    });

    el.chirality?.addEventListener('change', () => {
      leavePreset();
      state.chirality = chiralityFromCheckbox(el.chirality);
      void schedule();
    });

    el.candidateMode?.addEventListener('change', () => {
      leavePreset();
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
    renderPresetBar();
    renderVersion();
    bindControls();
    renderBoards();
    try {
      await engine.loadEngine();
      state.candidateMode = el.candidateMode?.value ?? state.candidateMode;
      state.yFlip = Boolean(el.yFlip?.checked);
      state.chirality = chiralityFromCheckbox(el.chirality);
      await loadPlaceInputs();
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
      chirality: state.chirality,
      candidateMode: state.candidateMode,
      pixels: state.pixels.map((point) => [point[0], point[1]]),
      basePixels: state.basePixels.map((point) => [point[0], point[1]]),
      ready: state.ready,
      sceneId: state.place.id,
      truthId: state.place.truthId,
      candidateCount: state.candidates.length,
      hasContext: { geo: geoCtx !== null, pixel: pixelCtx !== null },
      scene: state.result,
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
