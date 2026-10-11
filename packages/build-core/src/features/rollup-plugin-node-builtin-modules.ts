import type { Plugin } from 'rollup';
import { helpersDir } from '../helpers-dir.js';
import { join } from 'node:path';
import Ejs from 'ejs';

const nodeBuiltinModuleProxyPrefix = '\0oms-node-builtin-module:';
const nodeBuiltinModuleLoaderModuleId = '\0oms-node-builtin-module-loader';

const pluginName = 'oms:node-builtin-modules';

const nodeUnscopedBuiltinModules = [
  'assert',
  'assert/strict',
  'async_hooks',
  'buffer',
  'child_process',
  'cluster',
  'console',
  'constants',
  'crypto',
  'dgram',
  'diagnostics_channel',
  'dns',
  'dns/promises',
  'domain',
  'events',
  'fs',
  'fs/promises',
  'http',
  'http2',
  'https',
  'inspector',
  'inspector/promises',
  'module',
  'net',
  'os',
  'path',
  'path/posix',
  'path/win32',
  'perf_hooks',
  'process',
  'punycode',
  'querystring',
  'readline',
  'readline/promises',
  'repl',
  'stream',
  'stream/consumers',
  'stream/promises',
  'stream/web',
  'string_decoder',
  'sys',
  'timers',
  'timers/promises',
  'tls',
  'trace_events',
  'tty',
  'url',
  'util',
  'util/types',
  'v8',
  'vm',
  'wasi',
  'worker_threads',
  'zlib',
  'node:sea',
  'node:sqlite',
  'node:test',
  'node:test/reporters',
];

export function rollupPluginNodeBuiltinModules(opts: {
  supportsNativeModules: boolean;
}): Plugin {
  return {
    name: pluginName,

    resolveId(source) {
      if (source.startsWith('node:') || nodeUnscopedBuiltinModules.includes(source)) {
        if (opts.supportsNativeModules) {
          return {
            id: source,
            external: true,
          };
        }
        return nodeBuiltinModuleProxyPrefix + source;
      }
      if (source === nodeBuiltinModuleLoaderModuleId) {
        return source;
      }
    },

    async load(id) {
      if (id.startsWith(nodeBuiltinModuleProxyPrefix)) {
        const moduleId = id.slice(nodeBuiltinModuleProxyPrefix.length);
        const code = ``
          + `/// This module serves as a proxy for node builtin module ${moduleId}.\n`
          + `\n`
          + `import { requireNodeBuiltinModule } from '${nodeBuiltinModuleLoaderModuleId}';\n`
          + `export const __synthetic = requireNodeBuiltinModule('${moduleId}');\n`
        ;
        return {
          code,
          syntheticNamedExports: '__synthetic',
        };
      }

      if (id === nodeBuiltinModuleLoaderModuleId) {
        const template = await this.fs.readFile(join(helpersDir,
          'node-builtin-module-loader.ts.ejs'), { encoding: 'utf8' });
        const source = Ejs.render(template, {
          // nop for now
        });
        return source;
      }
    },
  };
}
