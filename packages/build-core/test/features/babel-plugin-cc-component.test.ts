import babel from '@babel/core';
import { expect, it } from 'vitest';
import dedent from 'dedent';
import { transformCCComponent } from '../../src/features/babel-plugin-cc-component.js';
import { describe } from 'node:test';
import { resolve } from 'node:path';

async function transform(code: string, filename: string | undefined, uuid: string | undefined) {
  const cwd = import.meta.dirname;
  const uuidMap: Record<string, string> = {};
  if (filename && uuid) {
    uuidMap[resolve(cwd, filename)] = uuid;
  }
  const transformResult = await babel.transformAsync(code, {
    cwd: cwd,
    filename,
    plugins: [
      transformCCComponent({
        uuidProvider(filename) {
          return uuidMap[filename];
        },
      }),
    ],
  });
  if (!transformResult?.code) {
    throw new Error('transform failed');
  }
  return transformResult.code;
}

void describe('transform', () => {
  const code = dedent`
    import { cclegacy as _ccLegacy } from 'cc';
    console.log('oops?');
  `;

  const filename = '_transform';
  const uuid = '123';

  void it('well formed', async () => {
    await expect(transform(code, filename, uuid)).resolves.matchSnapshot();
  });

  void it('lack of filename', async () => {
    await expect(transform(code, undefined, uuid)).resolves.matchSnapshot();
  });

  void it('lack of uuid', async () => {
    await expect(transform(code, filename, undefined)).resolves.matchSnapshot();
  });
});
