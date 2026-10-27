/**
 * デモの対比のプリセット（**データだけ**。DOM も engine も触らない）。
 *
 * プリセットの値（場面・候補の集め方・y の向き・正規化）・ボタンの文言・「見え方」の 1 行は
 * **このファイルだけ**に置く。デモ（`demo/main.js`）とテスト（`tests/demo-presets.e2e.test.ts`・
 * `tests/demo-wiring.test.ts`）はここを import する ∴ 打ち間違いは「対比が分かれない」テストで
 * 捕まる。場面そのものの値（範囲・GCP・真値）は `demo/scenes.js` が持つ。
 *
 * 各プリセットは `{ id, a: { label, input }, b: { label, input }, expect: { a, b } }`:
 * - `id` … 公開の名前（`data-preset="<id>:a"`）
 * - `input` … `{ scene, candidateMode, yFlip, chirality }`。`scene` は `demo/scenes.js` の場面の ID
 * - `expect` … 押したときに画面へ出す「見え方」の 1 行。対比の表の「見え方」の文面をそのまま写し、
 *   対比ごとに 1 つの定数を A・B の両方が参照する（同じ文を 2 か所に書かない）
 */
import { scenes } from './scenes.js';

/** プリセットの入力。書かない項目は次の既定を採る（A・B で違う項目だけを書く）。 */
function presetInput(sceneId, { candidateMode = 'catalog', yFlip = false, chirality = 'normalize' } = {}) {
  return Object.freeze({ scene: sceneId, candidateMode, yFlip, chirality });
}

/** A・B の 2 つのボタンの名前（画面とテストが同じ順に使う）。 */
export const PRESET_OPTION_IDS = Object.freeze(['a', 'b']);

/** 場所（京都と東京）で推定が分かれる。A・B で同じ 1 行を使う。 */
const PLACE_EXPECTATION =
  'A: 1 位は平面直角座標系 VI 系（とその同値の組）。B: 1 位は IX 系。候補の件数も変わる';

/** y の向き（画像の上下）で world file の符号だけが分かれる。A・B で同じ 1 行を使う。 */
const Y_DIRECTION_EXPECTATION =
  'どちらも VI 系とその同値の組（EPSG:2448・EPSG:6674・ESRI:112206）が上位。yScale の符号だけが分かれる（A は上向き、B は下向き）';

/** 正規化の有無で推定と札が分かれる。A・B で同じ 1 行を使う。 */
const NORMALIZATION_EXPECTATION =
  'A: 真値の組が上位で、識別力の札は「識別できている」。B: 真値が上位から落ち、識別力の札が「潰れている」になる（識別力は、同じ定義の候補をまとめて 1 つと数えたときの 1 位と 2 位の比）';

/** 対比の一覧。画面の帯とテストはこの順に使う。 */
export const PRESETS = Object.freeze([
  {
    id: 'place',
    a: { label: '京都の GCP', input: presetInput(scenes.kyoto.id) },
    b: { label: '東京の GCP', input: presetInput(scenes.tokyo.id) },
    expect: Object.freeze({ a: PLACE_EXPECTATION, b: PLACE_EXPECTATION }),
  },
  {
    id: 'y-direction',
    a: { label: 'y 上向き', input: presetInput(scenes.kyoto.id, { yFlip: false }) },
    b: { label: 'y 下向き（走査した地図）', input: presetInput(scenes.kyoto.id, { yFlip: true }) },
    expect: Object.freeze({ a: Y_DIRECTION_EXPECTATION, b: Y_DIRECTION_EXPECTATION }),
  },
  {
    id: 'normalization',
    a: { label: '正規化あり', input: presetInput(scenes.kyoto.id, { yFlip: true }) },
    b: {
      label: '正規化なし',
      input: presetInput(scenes.kyoto.id, { yFlip: true, chirality: 'direct-only' }),
    },
    expect: Object.freeze({ a: NORMALIZATION_EXPECTATION, b: NORMALIZATION_EXPECTATION }),
  },
]);

/** 対比の ID と A・B の名前で 1 つのプリセットの入力側を引く（画面のボタンとテストが使う）。 */
export function findPreset(presetId, optionId) {
  const preset = PRESETS.find((entry) => entry.id === presetId);
  if (!preset || !PRESET_OPTION_IDS.includes(optionId)) return undefined;
  const option = preset[optionId];
  return {
    presetId,
    optionId,
    label: option.label,
    input: option.input,
    expectation: preset.expect[optionId],
    scene: scenes[option.input.scene],
  };
}
