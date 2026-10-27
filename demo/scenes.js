/**
 * デモが扱う場面（**データだけ**。DOM も engine も触らない）。
 *
 * 場面の値（探索範囲・GCP の地理座標・真値の CRS・隣接 zone の ID）は**このファイルだけ**に置く。
 * デモ（`atlas-engine.js`・`main.js`）とテスト（`tests/demo-*.test.ts`）はここを import する ∴
 * 範囲の桁や CRS の ID を書き間違えれば、テストの対比が分かれなくなる形で捕まる。
 *
 * 各場面は `{ id, label, extent, gcpLonLat, truthId, zones }`:
 * - `extent` … 候補を引く範囲（`{west, south, east, north}` 度）
 * - `gcpLonLat` … GCP の地理座標（範囲の 4 隅と中心。lon-lat 順・度）
 * - `truthId` … 真値の CRS（pixel をこの CRS の投影座標から作る）。順位の表の「真値」の印もこれで付く
 * - `zones` … `zones` モードで拾う隣接 zone の ID
 */

/** 範囲の 4 隅と中心を `gcpLonLat` の形（京都と同じ形）で作る。 */
function cornersAndCentre({ west, south, east, north }) {
  return Object.freeze([
    Object.freeze([west, south]),
    Object.freeze([east, south]),
    Object.freeze([east, north]),
    Object.freeze([west, north]),
    Object.freeze([(west + east) / 2, (south + north) / 2]),
  ]);
}

function sceneOf({ id, label, extent, truthId, zones }) {
  const frozenExtent = Object.freeze({
    west: extent.west,
    south: extent.south,
    east: extent.east,
    north: extent.north,
  });
  return Object.freeze({
    id,
    label,
    extent: frozenExtent,
    gcpLonLat: cornersAndCentre(frozenExtent),
    truthId,
    zones: Object.freeze([...zones]),
  });
}

/** 京都近郊の探索範囲。`kyoto` と `kyoto-utjcp` は同じ範囲を使う（値を二重に書かない）。 */
const KYOTO_EXTENT = Object.freeze({ west: 135.6, south: 34.9, east: 135.9, north: 35.1 });

/** 場面の ID → 場面。デモの入力（`demo/presets.js` の `input.scene`）はこの ID で指す。 */
export const scenes = Object.freeze({
  kyoto: sceneOf({
    id: 'kyoto',
    label: '京都',
    extent: KYOTO_EXTENT,
    truthId: 'EPSG:6674',
    zones: ['EPSG:6673', 'EPSG:6674', 'EPSG:6675'],
  }),
  // 京都と同じ範囲・GCP で、真値だけを歴史グリッド（UTJCP の B 帯）にした場面。
  // 範囲と GCP の値は `kyoto` と共有する。
  'kyoto-utjcp': sceneOf({
    id: 'kyoto-utjcp',
    label: '京都（歴史グリッド）',
    extent: KYOTO_EXTENT,
    truthId: 'UTJCP:ZONE-B',
    zones: ['EPSG:6673', 'EPSG:6674', 'EPSG:6675'],
  }),
  tokyo: sceneOf({
    id: 'tokyo',
    label: '東京',
    extent: { west: 139.6, south: 35.6, east: 139.85, north: 35.75 },
    truthId: 'EPSG:6677',
    zones: ['EPSG:6676', 'EPSG:6677', 'EPSG:6678'],
  }),
});

/** 場面を指定しないときの場面（これまでのデモと同じ京都）。 */
export const DEFAULT_SCENE = scenes.kyoto;

/**
 * Daedalus のデモ（world file の当てはめ）の絶対 URL。
 *
 * Daedalus のデモは Daedalus の Pages にある ∴ Teiresias はそのパネルを持たず、リンクだけを持つ。
 * URL を持つのはこの 1 か所だけである（画面とテストが同じ値を import する）。
 */
export const DAEDALUS_DEMO_URL = 'https://code4history.dev/Daedalus/demo/worldfile-fit.html';
