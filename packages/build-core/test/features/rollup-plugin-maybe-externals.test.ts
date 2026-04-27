import { expect, it } from 'vitest';
import * as rollup from 'rollup';
import { join } from 'node:path';
import { rollupPluginMaybeExternals } from '../../src/features/rollup-plugin-maybe-externals.js';

it('_', async () => {
  const artifactsDir = join(import.meta.dirname, './artifacts/rollup-plugin-maybe-externals');
  const bundle = await rollup.rollup({
    input: join(artifactsDir, 'index.js'),
    plugins: [
      rollupPluginMaybeExternals({ maybeExternals: ['some-what'] }),
      {
        name: 'dummy',
        resolveId(id) {
          if (id.startsWith('some-what')) {
            return join(artifactsDir, id + '.js');
          }
        },
      },
    ],
  });
  const chunks = await bundle.generate({
    format: 'esm',
  });
  expect(Object.fromEntries(chunks.output.map((chunk) => {
    return chunk.type === 'chunk'
      ? [chunk.fileName, chunk.code]
      : [chunk.fileName, chunk.source];
  }))).toMatchSnapshot();
});
