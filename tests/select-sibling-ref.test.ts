import { describe, expect, it } from 'vitest';
// @ts-expect-error -- 型宣言を持たない .mjs（CI の step から node で直接起動するスクリプト）
import { main, parseLsRemoteHeads, selectSiblingRef } from '../scripts/select-sibling-ref.mjs';

/**
 * CI が兄弟リポジトリ（Daedalus・Atlas）を checkout するときの ref の選び方。
 * 順に「同名 → base_ref → 兄弟に在る train/* の辞書順で最大 → master」。
 */
describe('selectSiblingRef: 兄弟の ref の選び方', () => {
  it('同名のブランチが兄弟に在ればそれを選ぶ', () => {
    expect(
      selectSiblingRef({
        headRef: 'feature/x',
        baseRef: 'train/2026-12',
        siblingBranches: ['master', 'train/2026-12', 'feature/x'],
      }),
    ).toEqual({ ref: 'feature/x', reason: 'same name' });
  });

  it('PR で同名が無く base が在れば base を選ぶ', () => {
    expect(
      selectSiblingRef({
        headRef: 'feature/x',
        baseRef: 'train/2026-12',
        siblingBranches: ['master', 'train/2026-12'],
      }),
    ).toEqual({ ref: 'train/2026-12', reason: 'base ref' });
  });

  it('push で同名が無く train/2026-12 が在ればそれを選ぶ', () => {
    expect(
      selectSiblingRef({
        headRef: 'feature/x',
        baseRef: '',
        siblingBranches: ['master', 'train/2026-12'],
      }),
    ).toEqual({ ref: 'train/2026-12', reason: 'train branch' });
  });

  it('train/ が 2 つ在れば辞書順で最大のものを選ぶ', () => {
    expect(
      selectSiblingRef({
        headRef: 'feature/x',
        baseRef: undefined,
        siblingBranches: ['train/2027-01', 'master', 'train/2026-12'],
      }),
    ).toEqual({ ref: 'train/2027-01', reason: 'train branch' });
  });

  it('どれも無ければ master を選ぶ', () => {
    expect(
      selectSiblingRef({
        headRef: 'feature/x',
        baseRef: 'release',
        siblingBranches: ['master', 'develop'],
      }),
    ).toEqual({ ref: 'master', reason: 'fallback' });
  });

  it('headRef が空なら同名の段を飛ばす（空文字の枝は選ばない）', () => {
    expect(
      selectSiblingRef({
        headRef: '',
        baseRef: '',
        siblingBranches: ['', 'master'],
      }),
    ).toEqual({ ref: 'master', reason: 'fallback' });
    expect(
      selectSiblingRef({
        headRef: '',
        baseRef: '',
        siblingBranches: ['master', 'train/2026-12'],
      }),
    ).toEqual({ ref: 'train/2026-12', reason: 'train branch' });
  });
});

describe('parseLsRemoteHeads', () => {
  it('refs/heads/ の名前だけを取り出す', () => {
    const out = [
      '6c7f3897aaaa\trefs/heads/master',
      '6c7f3897bbbb\trefs/heads/train/2026-12',
      '6c7f3897cccc\trefs/tags/v1',
      '',
    ].join('\n');
    expect(parseLsRemoteHeads(out)).toEqual(['master', 'train/2026-12']);
  });
});

describe('main: CLI', () => {
  function run(env: Record<string, string | undefined>, branches: Record<string, string[]>) {
    const outputs: string[] = [];
    const logs: string[] = [];
    const code = main({
      argv: ['code4history/Daedalus', 'code4history/Atlas'],
      env,
      listBranches: (repo: string) => branches[repo] ?? [],
      writeOutput: (line: string) => outputs.push(line),
      log: (line: string) => logs.push(line),
    });
    return { code, outputs, logs };
  }

  it('PR では GITHUB_HEAD_REF・GITHUB_BASE_REF を使い、兄弟ごとに出力する', () => {
    const { code, outputs, logs } = run(
      { GITHUB_HEAD_REF: 'feature/x', GITHUB_BASE_REF: 'train/2026-12', GITHUB_REF_NAME: '5/merge' },
      {
        'code4history/Daedalus': ['master', 'train/2026-12', 'feature/x'],
        'code4history/Atlas': ['master', 'train/2026-12'],
      },
    );
    expect(code).toBe(0);
    expect(outputs).toEqual(['daedalus=feature/x', 'atlas=train/2026-12']);
    expect(logs).toEqual([
      'sibling ref code4history/Daedalus: feature/x (same name)',
      'sibling ref code4history/Atlas: train/2026-12 (base ref)',
    ]);
  });

  it('push では GITHUB_REF_NAME を使う', () => {
    const { outputs } = run(
      { GITHUB_HEAD_REF: '', GITHUB_BASE_REF: '', GITHUB_REF_NAME: 'feature/x' },
      {
        'code4history/Daedalus': ['master', 'train/2026-12'],
        'code4history/Atlas': ['master', 'feature/x'],
      },
    );
    expect(outputs).toEqual(['daedalus=train/2026-12', 'atlas=feature/x']);
  });

  it('兄弟に無い head ref の文字列は出力にもログにも写さない', () => {
    const hostile = 'x\natlas=evil$(id)';
    const { outputs, logs } = run(
      { GITHUB_HEAD_REF: hostile, GITHUB_BASE_REF: hostile, GITHUB_REF_NAME: '' },
      { 'code4history/Daedalus': ['master'], 'code4history/Atlas': ['master'] },
    );
    expect(outputs).toEqual(['daedalus=master', 'atlas=master']);
    expect([...outputs, ...logs].join('\n')).not.toContain('evil');
  });

  it('リポジトリ名の形が不正なら失敗する', () => {
    const outputs: string[] = [];
    const code = main({
      argv: ['code4history/Daedalus;rm'],
      env: {},
      listBranches: () => ['master'],
      writeOutput: (line: string) => outputs.push(line),
      log: () => {},
    });
    expect(code).not.toBe(0);
    expect(outputs).toEqual([]);
  });
});
