import { transform } from 'esbuild';
import type { Plugin } from 'rollup';

export function rollupPluginMinify(): Plugin {
  return {
    name: 'oms:minify',

    async renderChunk(code, chunk, outputOptions) {
      const format = outputOptions.format === 'system'
        ? 'iife'
        : outputOptions.format === 'es'
          ? 'esm'
          : undefined;
      const result = await transform(code, {
        loader: 'js',
        sourcefile: chunk.fileName,
        format,
        sourcemap: true,
        minify: true,
        keepNames: true,
        legalComments: 'inline',
      });
      return {
        code: result.code,
        map: result.map,
      };
    },
  };
}
