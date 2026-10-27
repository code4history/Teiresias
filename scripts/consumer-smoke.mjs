#!/usr/bin/env node
/**
 * Consumer smoke test: installs Atlas, Daedalus and Teiresias the way a user would (as
 * packages, never as source checkouts) into an empty directory outside the working tree,
 * then runs the whole flow through the public imports only:
 *
 *   Atlas candidate lookup -> Atlas createCandidateTransformer -> Teiresias estimateCrs
 *
 * Where the three packages come from:
 *   (no option)                  Atlas and Daedalus are packed from the sibling checkouts
 *                                (../Atlas, ../Daedalus), Teiresias from this checkout.
 *   --deps-from-registry <ver>   Atlas and Daedalus are <ver> from npm, Teiresias is packed.
 *   --from-registry <ver>        all three are <ver> from npm.
 *
 *   --scene <id>                 run one scene only (default: every scene).
 *
 * Output: one line of JSON on stdout, `{ "scenes": [{ "id", "ok", "reason", "k"? }], "ok" }`;
 * logs go to stderr. Exit code 0 when every scene holds, 1 otherwise (or after 300 s). The
 * proj-wasm workers keep the process alive after the work is done, so the scenes run in a
 * child process that ends with process.exit.
 *
 * Adding a scene: append one element to SCENES. The flow (candidates -> transformer ->
 * estimate) and the way GCPs are made (the unit of the truth CRS projects five points of the query
 * extent, which are scaled into pixels) do not depend on the scene; a scene only carries values and
 * its check.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TIME_LIMIT_MS = 300_000;
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const siblingsRoot = resolve(packageRoot, '..');

const KYOTO = { west: 135.6, south: 34.9, east: 135.9, north: 35.1 };
const DEFAULT_QUERY = { extent: KYOTO, area: 'Japan', onshoreOnly: true };

/** Candidates whose proj4 equals the truth's: they cannot be told apart by the fit. */
function degenerateClass(candidates, truthId) {
  const truth = candidates.find((row) => row.id === truthId);
  return truth === undefined ? [] : candidates.filter((row) => row.proj4 === truth.proj4).map((row) => row.id).sort();
}

const idOf = (entry) => `${entry.authority}:${entry.code}`;

/** The first k of `ranked` equal the degenerate class of the truth, as a set, and include the truth. */
function topKIsTruthClass(result, candidates, truthId) {
  const cls = degenerateClass(candidates, truthId);
  const k = cls.length;
  if (k === 0) return { ok: false, reason: `${truthId} is not among the candidates`, k };
  const top = result.ranked.slice(0, k).map(idOf).sort();
  const ok = top.length === k && top.every((id, i) => id === cls[i]) && top.includes(truthId);
  return { ok, reason: `ranked[0..${k - 1}] = ${top.join(', ')}; class = ${cls.join(', ')}`, k };
}

export const SCENES = [
  {
    id: 'a-y-up',
    query: DEFAULT_QUERY,
    truthId: 'EPSG:6674',
    pixelSpec: { metresPerPixel: 0.5, yDown: false },
    check: (result, candidates) => topKIsTruthClass(result, candidates, 'EPSG:6674'),
  },
  {
    id: 'b-y-down',
    query: DEFAULT_QUERY,
    truthId: 'EPSG:6674',
    pixelSpec: { metresPerPixel: 0.5, yDown: true },
    check: (result, candidates) => topKIsTruthClass(result, candidates, 'EPSG:6674'),
  },
  {
    id: 'c-y-down-yscale-negative',
    query: DEFAULT_QUERY,
    truthId: 'EPSG:6674',
    pixelSpec: { metresPerPixel: 0.5, yDown: true },
    check: (result) => {
      const yScale = result.selected?.worldFile.yScale;
      return { ok: typeof yScale === 'number' && yScale < 0, reason: `selected.worldFile.yScale = ${yScale}` };
    },
  },
  {
    id: 'd-utjcp-y-down',
    query: { extent: KYOTO, area: 'Japan', onshoreOnly: false, includeCustomProjections: true },
    truthId: 'UTJCP:ZONE-B',
    pixelSpec: { metresPerPixel: 10, yDown: true },
    check: (result) => {
      const top = result.ranked.length === 0 ? '(none)' : idOf(result.ranked[0]);
      const metresPerUnit = result.selected?.unit?.metresPerUnit;
      return {
        ok: top === 'UTJCP:ZONE-B' && metresPerUnit === 0.9143985307444408,
        reason: `ranked[0] = ${top}; selected.unit.metresPerUnit = ${metresPerUnit}`,
      };
    },
  },
];

/** Five points spread over the extent (not collinear), as lon/lat in lon-lat order. */
function pointsIn(extent) {
  const at = (fx, fy) => [extent.west + (extent.east - extent.west) * fx, extent.south + (extent.north - extent.south) * fy];
  return [at(0.33, 0.25), at(0.83, 0.35), at(0.5, 0.75), at(0.17, 0.9), at(0.67, 0.6)];
}

/** Runs one scene with the installed packages. Never throws: a failure becomes `ok: false`. */
async function runScene(scene, atlas, teiresias) {
  try {
    const candidates = await atlas.listProjectedCrsFromProjWasm(scene.query);
    const truth = candidates.find((row) => row.id === scene.truthId);
    if (truth === undefined) return { id: scene.id, ok: false, reason: `${scene.truthId} is not among the candidates` };
    const lonlat = pointsIn(scene.query.extent);
    const converted = await atlas.transformLonLatToCandidate(truth, lonlat);
    if (converted === null) return { id: scene.id, ok: false, reason: `${scene.truthId} cannot project the points` };
    const projected = converted.points;
    const e0 = Math.min(...projected.map((p) => p[0]));
    const n0 = Math.min(...projected.map((p) => p[1]));
    const { metresPerPixel, yDown } = scene.pixelSpec;
    const gcps = projected.map(([e, n], i) => ({
      pixel: [(e - e0) / metresPerPixel, ((n - n0) / metresPerPixel) * (yDown ? -1 : 1)],
      geo: lonlat[i],
    }));
    const result = await teiresias.estimateCrs(gcps, candidates, {
      transformer: atlas.createCandidateTransformer(candidates),
    });
    const verdict = scene.check(result, candidates);
    return { id: scene.id, ok: verdict.ok === true, reason: verdict.reason, ...(verdict.k === undefined ? {} : { k: verdict.k }) };
  } catch (error) {
    return { id: scene.id, ok: false, reason: `threw: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function parseArgs(argv) {
  const options = { mode: 'local', version: null, scene: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined || next.startsWith('--')) throw new Error(`${arg} needs a value`);
      return next;
    };
    if (arg === '--deps-from-registry') { options.mode = 'deps-from-registry'; options.version = value(); }
    else if (arg === '--from-registry') { options.mode = 'from-registry'; options.version = value(); }
    else if (arg === '--scene') options.scene = value();
    else throw new Error(`unknown option: ${arg}`);
  }
  return options;
}

function pnpm(args, cwd) {
  // stdout carries only the final JSON line, so pnpm's own output goes to stderr.
  execFileSync('pnpm', args, { cwd, stdio: ['ignore', process.stderr, 'inherit'] });
}

function pack(repoDir, destination) {
  const before = new Set(existsSync(destination) ? readdirSync(destination) : []);
  pnpm(['pack', '--pack-destination', destination], repoDir);
  const created = readdirSync(destination).filter((name) => name.endsWith('.tgz') && !before.has(name));
  if (created.length !== 1) throw new Error(`packing ${repoDir} made ${created.length} tarballs`);
  return join(destination, created[0]);
}

/** Installs the three packages into a new empty directory and returns it. */
function installConsumer(options) {
  const dir = mkdtempSync(join(tmpdir(), 'teiresias-consumer-'));
  const tarballs = join(dir, 'tarballs');
  mkdirSync(tarballs);
  const specs = {};
  const fromTarball = {};
  const take = (name, repoDir) => {
    const file = `file:${pack(repoDir, tarballs)}`;
    specs[name] = file;
    fromTarball[name] = file;
  };
  if (options.mode === 'local') {
    take('@c4h/atlas', join(siblingsRoot, 'Atlas'));
    take('@c4h/daedalus', join(siblingsRoot, 'Daedalus'));
    take('@c4h/teiresias', packageRoot);
  } else if (options.mode === 'deps-from-registry') {
    specs['@c4h/atlas'] = options.version;
    specs['@c4h/daedalus'] = options.version;
    take('@c4h/teiresias', packageRoot);
  } else {
    for (const name of ['@c4h/atlas', '@c4h/daedalus', '@c4h/teiresias']) specs[name] = options.version;
  }
  writeFileSync(
    join(dir, 'package.json'),
    `${JSON.stringify({ name: 'teiresias-consumer-smoke', private: true, type: 'module', dependencies: specs }, null, 2)}\n`,
  );
  // overrides also point Teiresias' own dependency on @c4h/daedalus at the same tarball.
  const workspace = [
    ...(Object.keys(fromTarball).length > 0
      ? ['overrides:', ...Object.entries(fromTarball).map(([name, file]) => `  "${name}": "${file}"`)]
      : []),
    'minimumReleaseAgeExclude:',
    '  - "@maplat/*"',
    '  - "@c4h/*"',
    '',
  ];
  writeFileSync(join(dir, 'pnpm-workspace.yaml'), workspace.join('\n'));
  // Re-exported from a file inside the consumer directory, so the imports resolve there.
  writeFileSync(
    join(dir, 'entry.mjs'),
    "export * as atlas from '@c4h/atlas';\nexport * as teiresias from '@c4h/teiresias';\n",
  );
  pnpm(['install'], dir);
  return dir;
}

const RESULT_MARKER = 'consumer-smoke-result ';

/** Child mode: runs the scenes with the packages installed in `dir`, prints the marked result. */
async function runInConsumer(dir, sceneId) {
  const scenes = sceneId === null ? SCENES : SCENES.filter((scene) => scene.id === sceneId);
  const { atlas, teiresias } = await import(pathToFileURL(join(dir, 'entry.mjs')).href);
  const results = [];
  for (const scene of scenes) results.push(await runScene(scene, atlas, teiresias));
  return { scenes: results, ok: results.length > 0 && results.every((result) => result.ok) };
}

/**
 * Parent mode: installs, then runs the scenes in a child process. proj-wasm and its worker
 * threads write logs to stdout, so the child marks its result line and the parent forwards
 * everything else to stderr, keeping stdout for the one line of JSON.
 */
function main(startedAt) {
  const options = parseArgs(process.argv.slice(2));
  if (options.scene !== null && !SCENES.some((scene) => scene.id === options.scene)) {
    throw new Error(`no scene named ${options.scene}`);
  }
  const dir = installConsumer(options);
  console.error(`consumer-smoke: installed into ${dir}`);
  const args = [fileURLToPath(import.meta.url), '--run-in', dir, ...(options.scene === null ? [] : ['--scene', options.scene])];
  const child = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    timeout: Math.max(1, TIME_LIMIT_MS - (Date.now() - startedAt)),
    maxBuffer: 1 << 26,
  });
  let outcome = null;
  for (const line of (child.stdout ?? '').split('\n')) {
    if (line.startsWith(RESULT_MARKER)) outcome = JSON.parse(line.slice(RESULT_MARKER.length));
    else if (line !== '') process.stderr.write(`${line}\n`);
  }
  if (outcome === null) {
    const why = child.error?.code === 'ETIMEDOUT' ? `timed out after ${TIME_LIMIT_MS / 1000} s` : `the run gave no result (exit ${child.status})`;
    return { scenes: [], ok: false, reason: why };
  }
  return outcome;
}

const isEntry = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
const runInIndex = process.argv.indexOf('--run-in');

if (isEntry && runInIndex !== -1) {
  const dir = process.argv[runInIndex + 1];
  const sceneIndex = process.argv.indexOf('--scene');
  const sceneId = sceneIndex === -1 ? null : process.argv[sceneIndex + 1];
  runInConsumer(dir, sceneId).then(
    (outcome) => {
      process.stdout.write(`${RESULT_MARKER}${JSON.stringify(outcome)}\n`);
      // The proj-wasm workers keep the process alive after the work is done.
      process.exit(outcome.ok ? 0 : 1);
    },
    (error) => {
      const reason = error instanceof Error ? error.message : String(error);
      process.stdout.write(`${RESULT_MARKER}${JSON.stringify({ scenes: [], ok: false, reason })}\n`);
      process.exit(1);
    },
  );
} else if (isEntry) {
  let outcome;
  try {
    outcome = main(Date.now());
  } catch (error) {
    outcome = { scenes: [], ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  process.stdout.write(`${JSON.stringify(outcome)}\n`);
  process.exit(outcome.ok ? 0 : 1);
}
