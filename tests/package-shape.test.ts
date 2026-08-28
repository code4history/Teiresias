/**
 * package 形状と依存境界の機械検証（m1-t1 設計 §8）。
 *
 * - AC-m1-1: `@c4h/daedalus` が `link:../Daedalus` の runtime dependency で、Atlas は
 *   runtime dependency でなく、`exports` は public root のみ。`private` / `license` 不変。
 * - AC-T2: Teiresias の `src` / `tests` 全域に Daedalus testkit / dist への禁止 import が 0 件。
 *   **手動 grep ではなく fs 全域走査 assert として結線する**（`outer rule-0012` の趣旨。
 *   設計レビュー第1ラウンド MIN-3）。
 * - AC-SCAFFOLD: scripts の結線、`vitest` と `@vitest/coverage-v8` の major 一致
 *   （`outer rule-0018`）、build 成果物に tests/fixtures が出ないこと。
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const testsDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(testsDir, '..');
const daedalusRoot = resolve(packageRoot, '..', 'Daedalus');

const packageJson = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
  name: string;
  private: boolean;
  license: string;
  type: string;
  main: string;
  types: string;
  exports: Record<string, unknown>;
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};

const tsconfigJson = JSON.parse(readFileSync(join(packageRoot, 'tsconfig.json'), 'utf8')) as {
  compilerOptions: Record<string, unknown>;
  include: string[];
};

/**
 * 禁止 needle は**分割した断片から組み立てる**。
 * 本ファイル自身が走査対象（`tests/`）に含まれるため、needle を literal で書くと
 * 検査が自分自身を検出して常に RED になる。
 */
const DAEDALUS_PKG = '@c4h/daedalus';
const FORBIDDEN_NEEDLES: readonly string[] = [
  `Daedalus/src/${'testkit'}`,
  `${DAEDALUS_PKG}/${'testkit'}`,
  `${DAEDALUS_PKG}/${'dist'}`,
];

/** ディレクトリ配下の全ファイルを再帰列挙する（シンボリックリンクは辿らない）。 */
function listFilesRecursively(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        found.push(full);
      }
    }
  };
  walk(root);
  return found.sort();
}

function majorOf(range: string): string {
  const match = /(\d+)\./.exec(range);
  if (match === null) throw new Error(`major を取り出せない version range: ${range}`);
  return match[1];
}

function sha256OfFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

describe('AC-m1-1: runtime dependency と公開 surface', () => {
  it('@c4h/daedalus が dependencies の link:../Daedalus である', () => {
    expect(packageJson.dependencies['@c4h/daedalus']).toBe('link:../Daedalus');
  });

  it('runtime dependencies は @c4h/daedalus の 1 件だけで、Atlas を含まない', () => {
    expect(Object.keys(packageJson.dependencies)).toEqual(['@c4h/daedalus']);
    const allDeps = [
      ...Object.keys(packageJson.dependencies),
      ...Object.keys(packageJson.devDependencies),
    ];
    expect(allDeps.filter((name) => name.toLowerCase().includes('atlas'))).toEqual([]);
  });

  it('exports は public root "." のみで、subpath を掲載しない', () => {
    expect(Object.keys(packageJson.exports)).toEqual(['.']);
    expect(packageJson.exports['.']).toEqual({
      types: './dist/index.d.ts',
      import: './dist/index.js',
      default: './dist/index.js',
    });
    expect(packageJson.main).toBe('./dist/index.js');
    expect(packageJson.types).toBe('./dist/index.d.ts');
  });

  it('private / license / name / type は m1-t1 で変更しない', () => {
    expect(packageJson.name).toBe('@c4h/teiresias');
    expect(packageJson.private).toBe(true);
    expect(packageJson.license).toBe('MIT');
    expect(packageJson.type).toBe('module');
  });

  it('公開 root export の runtime surface は estimateCrs だけで、内部 helper を漏出させない', async () => {
    const publicModule = await import('../src/index.js');
    expect(Object.keys(publicModule).sort()).toEqual(['estimateCrs']);

    // 内部 helper は ../src/estimate-crs.js からのみ到達できる（package root に載せない）
    const internals = await import('../src/estimate-crs.js');
    expect(Object.keys(internals).sort()).toEqual([
      'areScoresTied',
      'basicRmsFromFit',
      'computeObservationScale',
      'deriveSuccessStatus',
      'deriveTopLevelStatus',
      'estimateCrs',
      'normalizeEpsilonMeters',
      'normalizePositiveInteger',
      'rankCandidates',
    ]);
  });

  it('@c4h/daedalus は package の public root として解決でき、testkit は解決できない', async () => {
    const daedalus = await import('@c4h/daedalus');
    expect(typeof daedalus.fitWorldFile).toBe('function');

    await expect(import(`${DAEDALUS_PKG}/${'testkit'}`)).rejects.toThrowError();
    await expect(import(`${DAEDALUS_PKG}/${'dist'}/index.js`)).rejects.toThrowError();
  });
});

describe('AC-T2: Daedalus testkit / dist への禁止 import が 0 件', () => {
  it('src と tests の全ファイルに 3 needle が現れない（fs 全域走査）', () => {
    const scanned = [
      ...listFilesRecursively(join(packageRoot, 'src')),
      ...listFilesRecursively(join(packageRoot, 'tests')),
    ];
    expect(scanned.length).toBeGreaterThan(0);

    const hits: string[] = [];
    for (const file of scanned) {
      const content = readFileSync(file, 'utf8');
      for (const needle of FORBIDDEN_NEEDLES) {
        if (content.includes(needle)) {
          hits.push(`${relative(packageRoot, file)}: ${needle}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });

  it('走査が実際に発火することを、合成文字列に対して確認する（検査の自己検証）', () => {
    const synthetic = `import { mockTransformer } from '../../${'Daedalus/src/'}${'testkit'}/mockTransformer.js';`;
    const detected = FORBIDDEN_NEEDLES.filter((needle) => synthetic.includes(needle));
    expect(detected).toEqual([`Daedalus/src/${'testkit'}`]);
  });
});

describe('AC-SCAFFOLD: scaffolding の結線', () => {
  it('検証 script が 6 本すべて結線されている', () => {
    expect(packageJson.scripts).toMatchObject({
      build: 'tsc',
      typecheck: 'tsc --noEmit',
      test: 'vitest run',
      'test:watch': 'vitest',
      coverage: 'vitest run --coverage',
    });
    // test:types は tests/api-smoke.test.ts を tsc CLI の明示対象にする（設計 §3.4）
    expect(packageJson.scripts['test:types']).toContain('--noEmit');
    expect(packageJson.scripts['test:types']).toContain('tests/api-smoke.test.ts');
  });

  it('vitest と @vitest/coverage-v8 の major が一致する（outer rule-0018）', () => {
    expect(majorOf(packageJson.devDependencies['@vitest/coverage-v8'])).toBe(
      majorOf(packageJson.devDependencies.vitest),
    );
  });

  it('devDependencies は Daedalus 正史と同じ major に揃っている（設計 K13）', () => {
    const daedalusPackageJson = JSON.parse(
      readFileSync(join(daedalusRoot, 'package.json'), 'utf8'),
    ) as { devDependencies: Record<string, string> };
    for (const name of ['typescript', 'vitest', '@vitest/coverage-v8', '@types/node']) {
      expect(majorOf(packageJson.devDependencies[name])).toBe(
        majorOf(daedalusPackageJson.devDependencies[name]),
      );
    }
  });

  it('tsconfig の emit 対象は src のみで、tests / fixtures を含まない', () => {
    expect(tsconfigJson.include).toEqual(['src/**/*']);
    expect(tsconfigJson.compilerOptions.rootDir).toBe('src');
    expect(tsconfigJson.compilerOptions.outDir).toBe('dist');
    expect(tsconfigJson.compilerOptions.declaration).toBe(true);
    expect(tsconfigJson.compilerOptions.module).toBe('NodeNext');
    expect(tsconfigJson.compilerOptions.strict).toBe(true);
  });

  it('build 成果物 dist に tests / fixtures / testkit が存在しない', () => {
    const distDir = join(packageRoot, 'dist');
    if (!existsSync(distDir) || !statSync(distDir).isDirectory()) {
      // build 前に test を走らせた場合。§8.1 の順序では build 後にもう一度 test を回し、
      // その実行で本 assert が実際に発火する（task-state に両実行を記録する）。
      expect(tsconfigJson.include).toEqual(['src/**/*']);
      return;
    }
    const distFiles = listFilesRecursively(distDir).map((file) => relative(distDir, file));
    expect(distFiles.length).toBeGreaterThan(0);
    expect(
      distFiles.filter((file) => /(^|\/)(tests?|fixtures|testkit)(\/|$)/.test(file)),
    ).toEqual([]);
  });

  it('.gitignore が生成物を除外する（Daedalus 前例に踏襲）', () => {
    const ignored = readFileSync(join(packageRoot, '.gitignore'), 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
    expect(ignored).toEqual(['node_modules/', 'dist/', '*.tsbuildinfo']);
  });
});

describe('AC-T1 (b): fixture コピーの SHA-256 三者一致', () => {
  /** 契約文書 §5.3 が定める fixture の実測 SHA-256（fixtureVersion 1.0.0）。 */
  const SPECIFIED_SHA256 =
    'f95c73f10700e4bd7bdb681ebc8f6c3c9abd4104390b9b608b3303b56fec2df4';
  const copySource = join(daedalusRoot, 'src', `${'testkit'}`, 'mockContractFixture.ts');
  const copyTarget = join(packageRoot, 'tests', 'fixtures', 'mockContractFixture.ts');

  it('コピー元・コピー先・規定 SHA の 3 者が一致する', () => {
    expect(sha256OfFile(copySource)).toBe(SPECIFIED_SHA256);
    expect(sha256OfFile(copyTarget)).toBe(SPECIFIED_SHA256);
    expect(readFileSync(copyTarget)).toEqual(readFileSync(copySource));
  });

  it('コピー先は import を一切持たない純定数ファイルである（契約文書 §5.2）', () => {
    const lines = readFileSync(copyTarget, 'utf8').split('\n');
    expect(lines.filter((line) => /^\s*import\b/.test(line))).toEqual([]);
  });

  it('SHA 照合が実際に発火する（1 バイト変えたコピーは規定 SHA と一致しない）', () => {
    const mutated = createHash('sha256')
      .update(Buffer.concat([readFileSync(copyTarget), Buffer.from('\n')]))
      .digest('hex');
    expect(mutated).not.toBe(SPECIFIED_SHA256);
  });
});
