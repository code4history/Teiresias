/**
 * ソースのテキストの健全性。
 *
 * `src/`・`demo/`・`scripts/` の全ファイルに NUL バイト（0x00）が無いこと。NUL を含むファイルは
 * git や多くの道具でバイナリとして扱われ、差分とレビューから見えなくなる。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));

function listFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

describe('ソースのテキスト', () => {
  const files = ['src', 'demo', 'scripts'].flatMap((dir) => listFiles(join(root, dir)));

  it('対象のファイルが在る（検査が空振りしない）', () => {
    expect(files.some((file) => relative(root, file) === join('src', 'estimate-crs.ts'))).toBe(true);
    expect(files.length).toBeGreaterThan(5);
  });

  it('src・demo・scripts の全ファイルに NUL バイトが無い', () => {
    const withNul = files
      .filter((file) => readFileSync(file).includes(0))
      .map((file) => relative(root, file));
    expect(withNul).toEqual([]);
  });
});
