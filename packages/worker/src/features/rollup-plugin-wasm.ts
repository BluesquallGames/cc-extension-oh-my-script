import { parse, resolve } from 'node:path';
import type { Plugin } from 'rollup';
import { makeFileSystemAbsoluteImportSpecifier } from '../utils/import-specifier.js';

const wasmBinaryPostfix = '?wasm-binary';
const resolvedWasmBinaryPrefix = '\0oms-wasm-binary-resolved:';

export function rollupPluginWasm(opts: {

}): Plugin {
  return {
    name: 'oms:wasm',

    async resolveId(source, importer, options) {
      if (source.endsWith(wasmBinaryPostfix)) {
        const pre = source.slice(0, source.length - wasmBinaryPostfix.length);
        const resolved = await this.resolve(pre, importer, {
          skipSelf: true,
        });
        if (!resolved) {
          throw new Error(`Unable to resolve WebAssembly binary ${source} from ${importer}`);
        }
        if (resolved.external) {
          throw new Error(`WebAssembly binary ${source} from ${importer} can not named an external module`);
        }
        return {
          id: `${resolvedWasmBinaryPrefix}${resolved.id}`,
        };
      }
    },

    async load(id) {
      if (id.startsWith(resolvedWasmBinaryPrefix)) {
        const resolved = id.slice(resolvedWasmBinaryPrefix.length);
        const helper = resolve(import.meta.dirname, '../../injections/wasm-helper.ts');
        return [
          `// WebAssembly binary ${resolved}`,
          `import { importWasmBinary } from '${makeFileSystemAbsoluteImportSpecifier(helper)}';`,
          `export default (await importWasmBinary())`,
        ].join('\n') + '\n';
      }

      if (id.endsWith('.wasm')) {
        const helper = resolve(import.meta.dirname, '../../injections/wasm-helper.ts');
        const parsedPath = parse(id);
        const ref = this.emitFile({
          type: 'asset',
          name: `${parsedPath.name}.wasm`,
          source: await this.fs.readFile(id),
        });
        return [
          `// WebAssembly binary ${id}`,
          `import { importWasmInstance } from '${makeFileSystemAbsoluteImportSpecifier(helper)}';`,
          `export default (await importWasmInstance(import.meta.ROLLUP_FILE_URL_${ref}))`,
        ].join('\n') + '\n';
      }
    },
  };
}
