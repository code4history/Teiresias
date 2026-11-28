/**
 * 適合スコアの尺度（Issue #26）を確かめる試験の素材。
 *
 * - 相似で描かれた合成の地図（紙と地上がちょうど相似）
 * - 古地図のデモの実地図（GCP を `oldmap-gcps.json` へ間引いて写したもの）
 *
 * 候補の変換は、実 engine（Atlas の `createCandidateTransformer`）と、投影の式だけの mock の両方を使う。
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createCandidateTransformer } from '@c4h/atlas';

import type { CandidateTransformer, GcpPair } from '../../src/index.js';

/** Atlas の `createCandidateTransformer` が読む最小の行（id と proj4 だけ）。 */
export interface CandidateRow {
  id: string;
  authority: string;
  code: string;
  proj4: string;
}

function row(authority: string, code: string, proj4: string): CandidateRow {
  return { id: `${authority}:${code}`, authority, code, proj4 };
}

/** proj.db の EPSG:3857 の行と同じ文字列（+type=crs が無いと Atlas が変換できない）。 */
export const WEB_MERCATOR = row(
  'EPSG',
  '3857',
  '+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +wktext +no_defs +type=crs',
);

/** 平面直角座標系（JGD2011）。縮尺係数は 0.9999（原点の上）。 */
export const PLANE_VI = row(
  'EPSG',
  '6674',
  '+proj=tmerc +lat_0=36 +lon_0=136 +k=0.9999 +x_0=0 +y_0=0 +ellps=GRS80 +units=m +no_defs +type=crs',
);
export const PLANE_IX = row(
  'EPSG',
  '6677',
  '+proj=tmerc +lat_0=36 +lon_0=139.833333333333 +k=0.9999 +x_0=0 +y_0=0 +ellps=GRS80 +units=m +no_defs +type=crs',
);
export const PLANE_X = row(
  'EPSG',
  '6678',
  '+proj=tmerc +lat_0=40 +lon_0=140.833333333333 +k=0.9999 +x_0=0 +y_0=0 +ellps=GRS80 +units=m +no_defs +type=crs',
);

/** JGD2011 / UTM zone 54N。縮尺係数は中央子午線の上で 0.9996。 */
export const UTM_54N = row(
  'EPSG',
  '6691',
  '+proj=utm +zone=54 +ellps=GRS80 +units=m +no_defs +type=crs',
);

/** 実 engine の変換 adapter。 */
export function atlasTransformer(rows: readonly CandidateRow[]): CandidateTransformer {
  return createCandidateTransformer(rows) as CandidateTransformer;
}

// ---------------------------------------------------------------------------
// 投影の式だけの mock（engine を使わない）
// ---------------------------------------------------------------------------

const EARTH_RADIUS = 6378137;
const METRES_PER_DEGREE = 111320;
const RAD = Math.PI / 180;

/** EPSG:3857 の式（縮尺は緯度 φ で 1/cos φ 倍）。 */
export function webMercatorOf([lon, lat]: readonly [number, number]): [number, number] {
  return [EARTH_RADIUS * lon * RAD, EARTH_RADIUS * Math.log(Math.tan(Math.PI / 4 + (lat * RAD) / 2))];
}

/**
 * 地上の距離をそのまま座標にした写像（縮尺係数 1）。経緯度の `origin` を原点とする局所の東西・南北（m）。
 * 距離の近似は `computeObservationScale` と同じ（1 度 = 111320 m、東西は cos φ 倍）。
 */
export function groundOf(
  origin: readonly [number, number],
): (point: readonly [number, number]) => [number, number] {
  const cosLat = Math.cos(origin[1] * RAD);
  return ([lon, lat]) => [
    (lon - origin[0]) * METRES_PER_DEGREE * cosLat,
    (lat - origin[1]) * METRES_PER_DEGREE,
  ];
}

// ---------------------------------------------------------------------------
// 相似で描かれた合成の地図
// ---------------------------------------------------------------------------

/** 決定的な疑似ゆらぎ（-1〜1）。 */
function wobble(index: number, phase: number): number {
  return Math.sin(index * 12.9898 + phase * 78.233);
}

/**
 * 経緯度の格子（`size`×`size`・間隔 `stepDeg`）を中心 `centre` のまわりに並べる。
 */
export function lonLatGrid(
  centre: readonly [number, number],
  size: number,
  stepDeg: number,
): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const half = (size - 1) / 2;
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      out.push([centre[0] + (col - half) * stepDeg, centre[1] + (row - half) * stepDeg]);
    }
  }
  return out;
}

/**
 * 紙と地上がちょうど相似な地図の GCP。
 *
 * `truth` は地上の座標（m）を返す写像で、紙の画素は `truth` を 1/`metresPerPixel` に縮め、
 * 決定的な小さな誤差（`noiseMetres`・地上 m）を足したもの。誤差があるので、どの候補も残差は 0 にならない。
 */
export function similarityMap(
  lonLats: ReadonlyArray<readonly [number, number]>,
  truth: (point: readonly [number, number]) => [number, number],
  options: { metresPerPixel: number; noiseMetres: number },
): GcpPair[] {
  const base = truth(lonLats[0]);
  return lonLats.map((geo, index) => {
    const [x, y] = truth(geo);
    return {
      pixel: [
        (x - base[0] + options.noiseMetres * wobble(index, 1)) / options.metresPerPixel,
        (y - base[1] + options.noiseMetres * wobble(index, 2)) / options.metresPerPixel,
      ] as [number, number],
      geo: [geo[0], geo[1]] as [number, number],
    };
  });
}

// ---------------------------------------------------------------------------
// 古地図のデモの実地図
// ---------------------------------------------------------------------------

export interface RealMapCase {
  id: string;
  label: string;
  gcps: GcpPair[];
  /** その地図の位置に合う平面直角座標系。 */
  plane: CandidateRow;
}

interface RealMapFile {
  [id: string]: { label: string; gcps: Array<{ pixel: [number, number]; geo: [number, number] }> };
}

const PLANE_OF_MAP: Record<string, CandidateRow> = {
  morioka: PLANE_X,
  nara_1894: PLANE_VI,
  tatebayashi_castle_akimoto: PLANE_IX,
};

/** 実地図 3 枚（盛岡・奈良・館林）。 */
export function realMapCases(): RealMapCase[] {
  const file = fileURLToPath(new URL('./oldmap-gcps.json', import.meta.url));
  const data = JSON.parse(fs.readFileSync(file, 'utf8')) as RealMapFile;
  return Object.entries(data).map(([id, entry]) => ({
    id,
    label: entry.label,
    gcps: entry.gcps.map(({ pixel, geo }) => ({ pixel, geo })),
    plane: PLANE_OF_MAP[id],
  }));
}
