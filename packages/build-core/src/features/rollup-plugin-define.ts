import type { Plugin } from 'rollup';
import { transformSync } from 'oxc-transform';

export function rollupPluginDefine(options: {
  define: Record<string, string>;
  watchFiles: string[];
  sourcemap: boolean | 'inline';
}): Plugin {
  const defineCandidatePattern = makeDefineCandidatePattern(Object.keys(options.define));

  return {
    name: 'oms:define',

    buildStart() {
      for (const file of options.watchFiles) {
        this.addWatchFile(file);
      }
    },

    transform(code, id) {
      if (!defineCandidatePattern) {
        return undefined;
      }
      defineCandidatePattern.lastIndex = 0;
      // This regex only skips obviously irrelevant modules; OXC performs the AST-aware replacement.
      if (!defineCandidatePattern.test(code)) {
        return undefined;
      }

      const result = transformSync(id, code, {
        lang: 'js',
        sourceType: 'module',
        define: options.define,
        sourcemap: options.sourcemap !== false,
      });
      if (result.errors.length > 0) {
        this.error(result.errors.map((err) => err.codeframe || err.message).join('\n'));
      }
      return {
        code: result.code,
        map: result.map ?? null,
      };
    },
  };
}

function makeDefineCandidatePattern(keys: string[]) {
  const patterns = keys
    .filter((key) => key !== 'import.meta.env.*')
    .sort((a, b) => b.length - a.length)
    .map((key) => escapeRegExp(key).replaceAll('\\.', '\\??\\.'));
  if (patterns.length === 0) {
    return undefined;
  }
  return new RegExp(patterns.join('|'), 'g');
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
