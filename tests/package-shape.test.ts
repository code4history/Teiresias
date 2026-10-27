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

  /**
   * m2a-t1/AC-8（設計 v1.5 §5.4 発火 1。`outer rule-0015`）。
   *
   * m1-t1 の実装は `dependencies` と `devDependencies` の**両方**から Atlas を禁じていたが、
   * 守るべき不変条件は「Teiresias の**実行時**に engine が入らないこと」【C7】である。
   * 全面禁止はその十分条件でありながら**テストからの engine 注入も不可能にし**、仕様正本
   * `AC-m2a-2`（実 engine E2E）と正面から矛盾する。m1-t1/AC-m1-1 の文言自体が
   * 「型だけの Atlas import と区別される」と型専用参照の存在を前提にしている。
   *
   * ∴ 緩めるのではなく**本来の不変条件へ置き換える**: (a) `dependencies` が 1 件であること、
   * (b) `src` 全域に Atlas 参照が 0 件であることの積で担保する（(b) は依存名一覧より強い）。
   */
  it('runtime dependencies は @c4h/daedalus の 1 件だけで、Atlas を含まない', () => {
    expect(Object.keys(packageJson.dependencies)).toEqual(['@c4h/daedalus']);
    expect(
      Object.keys(packageJson.dependencies).filter((name) => name.toLowerCase().includes('atlas')),
    ).toEqual([]);
  });

  it('Atlas は devDependency としてのみ存在し、link:../Atlas で解決する（m2a-t1）', () => {
    expect(packageJson.devDependencies['@c4h/atlas']).toBe('link:../Atlas');
  });

  it('Teiresias src は Atlas を一切参照しない（fs 全域走査。C7 engine 直参照禁止）', () => {
    // needle は断片から組み立てる（本ファイルは tests/ 配下だが、走査範囲は src/ のみ ∴
    // 自己検出はしない。それでも m1-t1 の FORBIDDEN_NEEDLES と同じ配慮を残す）。
    // **走査範囲を tests/ へ広げてはならない** — 新 E2E 自身が必ずヒットする。
    const needle = `@c4h/${'atlas'}`;
    const scanned = listFilesRecursively(join(packageRoot, 'src'));
    expect(scanned.length).toBeGreaterThan(0);

    const hits = scanned.filter((file) =>
      readFileSync(file, 'utf8').toLowerCase().includes(needle),
    );
    expect(hits.map((file) => relative(packageRoot, file))).toEqual([]);
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

  /**
   * m3-t1/AC-8（設計 v1.3 §6.1 / §2 #17）。
   *
   * デモのビルド経路（`dev` / `build:demo` / `verify:demo` / `verify:demo-bundle`）と
   * 観測経路（`preview` = m3-t1/AC-16 の起動経路）を **5 キー**として機械固定する。
   * `toMatchObject` はキー追加では壊れない ∴ 追加した側を明示 assert する
   * （`outer rule-0012` の趣旨。結線の存在を検査から辿れるようにする）。
   */
  it('デモの build / verify / preview script が 5 キー結線されている（m3-t1/AC-8）', () => {
    expect(packageJson.scripts).toMatchObject({
      dev: 'vite --host',
      'build:demo': 'vite build',
      preview: 'vite preview',
    });
    expect(packageJson.scripts['verify:demo']).toContain('verify-demo-pages-build.mjs');
    expect(packageJson.scripts['verify:demo']).toContain('GITHUB_PAGES=true');
    expect(packageJson.scripts['verify:demo-bundle']).toContain('verify-demo-browser-bundle.mjs');
  });

  /**
   * m3-t1/AC-8。デモのビルド・検証に必要な 3 件は **devDependencies にだけ**入れる。
   * `proj-wasm` を `dependencies` へ入れると Teiresias の公開 package が engine に
   * 依存することになり【C7】が package の形として破れる（設計 §6.1）。
   */
  it('デモ用 devDependencies 3 件が入り、dependencies は増えていない（m3-t1/AC-8）', () => {
    expect(packageJson.devDependencies.vite).toBeTypeOf('string');
    expect(packageJson.devDependencies['proj-wasm']).toBeTypeOf('string');
    expect(packageJson.devDependencies.jsdom).toBeTypeOf('string');
    expect(packageJson.dependencies['proj-wasm']).toBeUndefined();
    expect(packageJson.dependencies.vite).toBeUndefined();
  });

  /**
   * m2a-t1: Atlas 型契約（AC-1(a)）の検査経路を結線する（`outer rule-0012`）。
   *
   * `test:types` は `moduleResolution NodeNext` であり、Atlas の `dist/*.d.ts` が相対 import を
   * 拡張子なしで出力している（NodeNext では TS2834）ため `--skipLibCheck` と相まって
   * `ProjectedCrsInfo` が `any` へ縮退する ∴ その経路だけでは AC-1(a) が vacuous になる。
   * `moduleResolution Bundler` の第 2 経路を別 script として足す（`&&` で連ねない）。
   */
  it('Atlas 型契約の検査 script が結線されている（m2a-t1/AC-1a）', () => {
    const script = packageJson.scripts['test:types:atlas'];
    expect(script).toBeTypeOf('string');
    expect(script).toContain('--noEmit');
    expect(script).toContain('--moduleResolution Bundler');
    expect(script).toContain('tests/api-smoke.test.ts');
    // Atlas の公開 adapter が Teiresias の CandidateTransformer へ型でつながること
    expect(script).toContain('tests/atlas-adapter-contract.test.ts');
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

  it('build 成果物 dist に tests / fixtures / testkit / demo が存在しない', () => {
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
      // m3-t1/AC-8（設計 §4.4）: `demo` を needle へ追加する。`demo/` は `@c4h/atlas` を
      // import する ∴ dist へ混入すると【C7】（Teiresias が engine を直参照しない）が
      // 公開 package の形として破れる。tsconfig の `include: ["src/**/*"]` により構造上
      // 入らないが、**入らないことを機械で固定する**（被影響への追随ではなく追加である）。
      distFiles.filter((file) => /(^|\/)(tests?|fixtures|testkit|demo)(\/|$)/.test(file)),
    ).toEqual([]);
  });

  it('.gitignore が生成物を除外する（Daedalus 前例に踏襲）', () => {
    const ignored = readFileSync(join(packageRoot, '.gitignore'), 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
    // m2a-t1: MIN-IR-3（m1-t1 からの持ち越し）で `coverage/` を追加した。
    // m3-t1: デモの生成物 `dist-demo/` と作業領域 `.tmp/` を追加した（設計 §2 #18。
    // `outer rule-0015` — 期待値を無効化する変更は同じ変更で spec を追随させる）。
    // 完全一致 assert のまま追随させる（順不同集合へ緩めない。生成物除外の全数固定を保つ）。
    expect(ignored).toEqual([
      'node_modules/',
      'dist/',
      'coverage/',
      '*.tsbuildinfo',
      'dist-demo/',
      '.tmp/',
    ]);
  });
});

describe('AC-T1 (b): fixture コピーの SHA-256 三者一致', () => {
  /** 契約文書が定める fixture の実測 SHA-256（fixtureVersion 1.0.1）。 */
  const SPECIFIED_SHA256 =
    '5da3d253e46a0dc6f8710432fc0783a261fbb35ca0c47757b0b204a48fa85495';
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
