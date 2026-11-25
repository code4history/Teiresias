/**
 * 失敗の message を 500 文字で切った結果が、元の長い文字列を抱え続けないこと（SR-DEC26-F-5）。
 *
 * 長い文面で throw する transformer を多数の候補に当て、結果を持ったまま GC した後の
 * `heapUsed` の増分が、切った後の合計（候補数 × 500 文字）に見合う大きさに収まることを見る。
 * 規模は CI で重くならない大きさ（元の文面の合計は約 100 MB）にしている。
 */
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';

import { describe, expect, it } from 'vitest';

import { estimateCrs } from '../src/index.js';
import type { CandidateCrs } from '../src/index.js';
import { teiresiasE2eGcps } from './fixtures/mockTransformer.js';

const CANDIDATE_COUNT = 2_000;
const RAW_MESSAGE_LENGTH = 50_000;
const TRUNCATED_LENGTH = 500;
/** 切った後の合計は約 1 MB。元の文面を抱えたままなら約 100 MB 増える。 */
const HEAP_GROWTH_LIMIT_BYTES = 16 * 1024 * 1024;

setFlagsFromString('--expose-gc');
const collectGarbage = runInNewContext('gc') as () => void;

async function settledHeapUsed(): Promise<number> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  collectGarbage();
  collectGarbage();
  return process.memoryUsage().heapUsed;
}

describe('失敗 message の切り詰めとメモリ', () => {
  it('長い文面の失敗が多数あっても、結果が抱えるメモリは切った後の大きさに収まる', async () => {
    const candidates: CandidateCrs[] = Array.from({ length: CANDIDATE_COUNT }, (_, index) => ({
      authority: 'MOCK',
      code: `C${index}`,
    }));
    const filler = 'x'.repeat(RAW_MESSAGE_LENGTH);

    const before = await settledHeapUsed();
    const result = await estimateCrs(teiresiasE2eGcps, candidates, {
      transformer: (id) => {
        // 候補ごとに別の文字列を作る（同じ文字列の使い回しでは増分が見えない）
        throw new Error(`${id} ${filler}`);
      },
    });
    const after = await settledHeapUsed();

    const messages = result.failure?.candidates.map((candidate) => candidate.message) ?? [];
    expect(result.status).toBe('failed');
    expect(messages).toHaveLength(CANDIDATE_COUNT);
    expect(messages.every((message) => message.length === TRUNCATED_LENGTH)).toBe(true);
    expect(messages[7]).toBe(`MOCK:C7 ${filler}`.slice(0, TRUNCATED_LENGTH));
    expect(after - before).toBeLessThan(HEAP_GROWTH_LIMIT_BYTES);
  });

  it('切った結果の内容は元の先頭 500 文字と同じ（サロゲートペア・結合文字を含む）', async () => {
    const raw = '地図𠮷👨‍👩‍👧é'.repeat(200);
    const result = await estimateCrs(teiresiasE2eGcps, [{ authority: 'MOCK', code: 'C' }], {
      transformer: () => {
        throw new Error(raw);
      },
    });
    expect(result.failure?.candidates[0].message).toBe(raw.slice(0, TRUNCATED_LENGTH));
  });
});
