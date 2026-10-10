// @ts-check
import { defineConfig } from '@oms/plugin';

/** @type {import('@oms/plugin').OmsPlugin} */
const plugin = {
  name: 'test:javascript',
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
    this.addWatchFile('/source/types.d.ts');
    return {
      code: `export default ${JSON.stringify(id)}`,
      map: null,
    };
  },
};

defineConfig({
  plugins: [plugin],
});

defineConfig(async ({ mode }) => ({
  mode,
  plugins: [plugin],
}));

/** @type {import('@oms/plugin').OmsPlugin} */
const wrongHook = {
  name: 'test:wrong-hook',
  // @ts-expect-error Module ids are strings even in plain JS consumers.
  load: (id) => id.toFixed(),
};
void wrongHook;
