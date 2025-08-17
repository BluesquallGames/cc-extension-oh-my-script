import { parse, resolve } from 'node:path';
import type { Plugin } from 'rollup';
import { makeFileSystemAbsoluteImportSpecifier } from '../utils/import-specifier.js';
import { format } from 'node:util';

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
        const wasmBinary = await this.fs.readFile(id);
        let wasmModule: WebAssembly.Module;
        try {
          wasmModule = await WebAssembly.compile(wasmBinary);
        } catch (err) {
          return this.error(format(`Failed to compile WebAssembly module ${id}: %o`, err));
        }
        const imports = WebAssembly.Module.imports(wasmModule);
        const importModules = new Set<string>();
        for (const imp of imports) {
          importModules.add(imp.module);
        }
        const ref = this.emitFile({
          type: 'asset',
          name: `${parsedPath.name}.wasm`,
          source: wasmBinary,
        });
        const importModuleSpecifiers = [...importModules];
        return [
          `// WebAssembly binary ${id}`,
          `import { importWasmInstance } from '${makeFileSystemAbsoluteImportSpecifier(helper)}';`,
          ...importModuleSpecifiers.map((m, i) => {
            return `import * as imp_${i} from '${m}';\n`;
          }),
          '',
          `const imports = {`,
          ...importModuleSpecifiers.map((m, i) => {
            return `  '${m}': imp_${i},`;
          }),
          `};`,
          '',
          `export default (await importWasmInstance(import.meta.ROLLUP_FILE_URL_${ref}, imports))`,
        ].join('\n') + '\n';
      }
    },
  };
}
