#!/usr/bin/env node
/**
 * CI が兄弟リポジトリ（Daedalus・Atlas）を checkout するときの ref を選ぶ。
 *
 * 選ぶ順:
 *   1. 自分の head ref と同名のブランチが兄弟に在ればそれ
 *   2. base ref（PR の向き先）が兄弟に在ればそれ
 *   3. 兄弟に在る `train/` で始まるブランチのうち辞書順で最大のもの
 *   4. `master`
 *
 * 使い方（GitHub Actions の step から）:
 *   node Teiresias/scripts/select-sibling-ref.mjs code4history/Daedalus code4history/Atlas
 *
 * `$GITHUB_OUTPUT` に `<リポジトリ名の小文字>=<ref>` を書き、標準出力に
 * `sibling ref <repo>: <ref> (<理由>)` を出す。
 *
 * セキュリティ: フォークからの PR の `GITHUB_HEAD_REF` は第三者が決める文字列である。
 * 出力（`$GITHUB_OUTPUT`・標準出力）に書くのは、`git ls-remote` が返した兄弟の
 * ブランチ名か `master` だけで、環境変数の値をそのまま写すことはしない。
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const TRAIN_PREFIX = 'train/';
const FALLBACK = 'master';
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/**
 * @param {{ headRef?: string, baseRef?: string, siblingBranches: string[] }} input
 * @returns {{ ref: string, reason: 'same name' | 'base ref' | 'train branch' | 'fallback' }}
 */
export function selectSiblingRef({ headRef, baseRef, siblingBranches }) {
  const branches = siblingBranches.filter((name) => typeof name === 'string' && name !== '');
  const found = (wanted) =>
    typeof wanted === 'string' && wanted !== '' ? branches.find((name) => name === wanted) : undefined;

  const same = found(headRef);
  if (same !== undefined) return { ref: same, reason: 'same name' };

  const base = found(baseRef);
  if (base !== undefined) return { ref: base, reason: 'base ref' };

  const trains = branches.filter((name) => name.startsWith(TRAIN_PREFIX) && name.length > TRAIN_PREFIX.length);
  if (trains.length > 0) {
    const latest = trains.reduce((max, name) => (name > max ? name : max));
    return { ref: latest, reason: 'train branch' };
  }

  return { ref: FALLBACK, reason: 'fallback' };
}

/**
 * `git ls-remote --heads` の出力からブランチ名を取り出す。
 * @param {string} output
 * @returns {string[]}
 */
export function parseLsRemoteHeads(output) {
  const prefix = 'refs/heads/';
  const names = [];
  for (const line of output.split('\n')) {
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const ref = line.slice(tab + 1).trim();
    if (ref.startsWith(prefix) && ref.length > prefix.length) names.push(ref.slice(prefix.length));
  }
  return names;
}

/** @param {string} repo */
function listBranchesFromGitHub(repo) {
  const output = execFileSync('git', ['ls-remote', '--heads', `https://github.com/${repo}.git`], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return parseLsRemoteHeads(output);
}

/**
 * @param {{
 *   argv: string[],
 *   env: Record<string, string | undefined>,
 *   listBranches: (repo: string) => string[],
 *   writeOutput: (line: string) => void,
 *   log: (line: string) => void,
 * }} deps
 * @returns {number} 終了コード
 */
export function main({ argv, env, listBranches, writeOutput, log }) {
  if (argv.length === 0 || !argv.every((repo) => REPO_PATTERN.test(repo))) {
    log('usage: select-sibling-ref.mjs <owner>/<repo> [<owner>/<repo> ...]');
    return 2;
  }
  // PR では GITHUB_HEAD_REF（PR の元ブランチ）、push では GITHUB_REF_NAME。
  const headRef = env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME || '';
  const baseRef = env.GITHUB_BASE_REF || '';

  const results = argv.map((repo) => {
    const { ref, reason } = selectSiblingRef({ headRef, baseRef, siblingBranches: listBranches(repo) });
    return { repo, key: repo.split('/')[1].toLowerCase(), ref, reason };
  });
  for (const { repo, key, ref, reason } of results) {
    writeOutput(`${key}=${ref}`);
    log(`sibling ref ${repo}: ${ref} (${reason})`);
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const outputFile = process.env.GITHUB_OUTPUT;
  process.exitCode = main({
    argv: process.argv.slice(2),
    env: process.env,
    listBranches: listBranchesFromGitHub,
    writeOutput: (line) => {
      if (outputFile) appendFileSync(outputFile, `${line}\n`);
    },
    log: (line) => console.log(line),
  });
}
