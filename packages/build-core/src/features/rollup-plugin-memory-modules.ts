import type { Plugin } from 'rollup';

export function rollupPluginMemoryModules(opts: {
  modules: Record<string, string>;
}): Plugin {
  return {
    name: 'oms:memory-modules',

    resolveId(id) {
      if (opts.modules[id]) {
        return id;
      }
    },

    load(id) {
      if (opts.modules[id]) {
        return opts.modules[id];
      }
    },
  };
}
