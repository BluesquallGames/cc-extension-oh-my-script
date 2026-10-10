import type { OmsPlugin, OmsPluginContext, OmsUserConfig } from '@oms/plugin';
import type { RollupError } from 'rollup';

export const plugin = {
  name: 'test:source-loader',
  enforce: 'pre',
  buildStart() {
    this.cache.set('modules', {});
  },
  async resolveId(source, importer, options) {
    const { importerAttributes, ...forwardedOptions } = options;
    return this.resolve(source, importer, {
      ...forwardedOptions,
      ...(importerAttributes ? { importerAttributes } : {}),
    });
  },
  load(id) {
    this.addWatchFile('/src/image.meta');
    this.cache.get('modules');
    return {
      code: `export default ${JSON.stringify(id)}`,
      map: null,
    };
  },
} satisfies OmsPlugin;

export const userConfig: OmsUserConfig = {
  plugins: [plugin],
  profiles: {
    headless: {
      include: [],
      build: {
        target: 'node22',
      },
    },
  },
};

declare const context: OmsPluginContext;
declare const diagnostic: RollupError;
const fatal: never = context.error(diagnostic);
void fatal;
/// @expect Only the used native context operations are public.
// @ts-expect-error
context.warn('warning');
// @ts-expect-error
context.cache.has('modules');
// @ts-expect-error
context.cache.delete('modules');
// @ts-expect-error
context.config;

/// @expect Removed hooks cannot be authored against the public interface.
// @ts-expect-error
export const config: OmsPlugin = { name: 'config', config() {} };
// @ts-expect-error
export const resolvedConfig: OmsPlugin = { name: 'configResolved', configResolved() {} };
// @ts-expect-error
export const transform: OmsPlugin = { name: 'transform', transform() {} };
// @ts-expect-error
export const watch: OmsPlugin = { name: 'watchChange', watchChange() {} };
// @ts-expect-error
export const end: OmsPlugin = { name: 'buildEnd', buildEnd() {} };
// @ts-expect-error
export const close: OmsPlugin = { name: 'closeBundle', closeBundle() {} };
// @ts-expect-error
export const post: OmsPlugin = { name: 'post', enforce: 'post' };
// @ts-expect-error
export const objectHook: OmsPlugin = { name: 'object', load: { handler() {} } };
// @ts-expect-error
export const dev: OmsPlugin = { name: 'dev', configureServer() {} };
// @ts-expect-error
export const hmr: OmsPlugin = { name: 'hmr', handleHotUpdate() {} };
