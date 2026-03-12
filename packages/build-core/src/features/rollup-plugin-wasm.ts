import { join, parse, resolve } from 'node:path';
import type { Plugin } from 'rollup';
import { makeFileSystemAbsoluteImportSpecifier } from '../utils/import-specifier.js';
import { format } from 'node:util';
import { helpersDir } from '../helpers-dir.js';
import Ejs from 'ejs';

const wasmBinaryPostfix = '?wasm-binary';
const resolvedWasmBinaryPrefix = '\0oms-wasm-binary-resolved:';
const resolvedEmscriptenGlueWrapper = '\0oms-emscripten-glue:';
const wasmBinaryPathPrefix = '\0oms-wasm-binary-path:';
const glueImportModuleId = '\0oms-wasm-glue-imported-module';
const gluePrefix = '\0oms-wasm-glue:';

const pluginName = 'oms:wasm';

export function rollupPluginWasm(opts: {
}): Plugin {
  return {
    name: pluginName,

    async resolveId(source, importer, options) {
      if (source.startsWith(wasmBinaryPathPrefix)) {
        return source;
      }

      if (source.endsWith(wasmBinaryPostfix)) {
        const pre = source.slice(0, source.length - wasmBinaryPostfix.length);
        const resolved = await this.resolve(pre, importer, {
          skipSelf: true,
        });
        if (!resolved) {
          return this.error(`Unable to resolve WebAssembly binary ${source} from ${importer}`);
        }
        if (resolved.external) {
          return this.error(`WebAssembly binary ${source} from ${importer} can not named an external module`);
        }
        return {
          id: `${resolvedWasmBinaryPrefix}${resolved.id}`,
        };
      }

      if (options.attributes.type === 'oms:emscripten-glue') {
        const resolved = await this.resolve(source, importer, {
          skipSelf: true,
        });
        if (!resolved) {
          return this.error(`Unable to resolve Emscripten glue ${source} from ${importer}`);
        }
        if (resolved.external) {
          return this.error(`Emscripten glue ${source} from ${importer} can not named an external module`);
        }
        return {
          id: `${resolvedEmscriptenGlueWrapper}${resolved.id}`,
        };
      }

      if (source.startsWith(gluePrefix)) {
        return source;
      }

      // Emscripten glue has `import('module')`
      if (importer && source === 'module' && (importer.startsWith(gluePrefix) || true)) {
        return glueImportModuleId;
      }
    },

    async load(id) {
      if (id.startsWith(wasmBinaryPathPrefix)) {
        const wasmBinaryPath = id.slice(wasmBinaryPathPrefix.length);
        const wasmBinary = await this.fs.readFile(wasmBinaryPath);
        const wasmBinaryParsedPath = parse(wasmBinaryPath);
        const ref = this.emitFile({
          type: 'asset',
          name: `${wasmBinaryParsedPath.name}.wasm`,
          source: wasmBinary,
        });
        return `export default import.meta.ROLLUP_FILE_URL_${ref};`;
      }

      if (id.startsWith(resolvedWasmBinaryPrefix)) {
        const wasmBinaryPath = id.slice(resolvedWasmBinaryPrefix.length);
        const helper = resolve(helpersDir, 'wasm-helper.ts');
        return [
          `// WebAssembly binary ${wasmBinaryPath}`,
          `import { importWasmBinary } from '${makeFileSystemAbsoluteImportSpecifier(helper)}';`,
          `import wasmBinaryPath from '${wasmBinaryPathPrefix + makeFileSystemAbsoluteImportSpecifier(wasmBinaryPath)}';`,
          `export default (await importWasmBinary(wasmBinaryPath))`,
        ].join('\n') + '\n';
      }

      if (id.endsWith('.wasm')) {
        const helper = resolve(helpersDir, 'wasm-helper.ts');
        const wasmBinary = await this.fs.readFile(id) as Uint8Array<ArrayBuffer>;
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
        const importModuleSpecifiers = [...importModules];
        return [
          `// WebAssembly binary ${id}`,
          `import { importWasmInstance } from '${makeFileSystemAbsoluteImportSpecifier(helper)}';`,
          `import wasmBinaryPath from '${wasmBinaryPathPrefix + makeFileSystemAbsoluteImportSpecifier(id)}';`,
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
          `export default (await importWasmInstance(wasmBinaryPath, imports))`,
        ].join('\n') + '\n';
      }

      if (id.startsWith(resolvedEmscriptenGlueWrapper)) {
        const resolved = id.slice(resolvedEmscriptenGlueWrapper.length);
        const template = await this.fs.readFile(join(helpersDir, 'emscripten-glue-wrapper.ts.ejs'), { encoding: 'utf8' });
        const parsedGluePath = parse(resolved);
        const source = Ejs.render(template, {
          glueModule: makeFileSystemAbsoluteImportSpecifier(gluePrefix + resolved),
          wasmHelperModule: makeFileSystemAbsoluteImportSpecifier(resolve(helpersDir, 'wasm-helper.ts')),
          wasmBinaryPathModule: makeFileSystemAbsoluteImportSpecifier(wasmBinaryPathPrefix + `${join(parsedGluePath.dir, parsedGluePath.name)}.wasm`),
        });
        return source;
      }

      if (id.startsWith(gluePrefix)) {
        const glueModule = id.slice(gluePrefix.length);
        const glueModulePath = resolve(glueModule);
        const source = await this.fs.readFile(glueModulePath, { encoding: 'utf8' });
        return `var process = undefined; var window = globalThis; ${source}`;
      }

      if (id === glueImportModuleId) {
        return `throw new Error('Can not import ${'module'}');`;
      }
    },
  };
}
