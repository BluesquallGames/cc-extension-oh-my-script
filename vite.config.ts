import { defineConfig, Plugin } from 'vite';
import vue from '@vitejs/plugin-vue';
import { builtinModules } from 'node:module';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const readDirEntries = (() => {
  async function* r(root: string, currentDir: string = ''): AsyncGenerator<string> {
    const dir = resolve(root, currentDir);
    for (const filename of await readdir(dir)) {
      const file = resolve(dir, filename);
      const stats = await stat(file);
      const subpath = `${currentDir ? `${currentDir}/` : ''}${filename}`;
      if (stats.isDirectory()) {
        yield * r(root, subpath);
      } else if (stats.isFile()) {
        yield subpath;
      }
    }
  }

  return async (root: string, currentDir: string = '') => {
    if (!existsSync(resolve(root, currentDir))) {
      return [];
    }
    const entries: string[] = [];
    for await (const entry of r(root, currentDir)) {
      entries.push(entry);
    }
    return entries;
  };
})();

function defineEntries(files: string[]) {
  return Object.fromEntries(files.map((f) => {
    const src = `./src/${f}`;
    if (!existsSync(join(src))) {
      console.warn(`file not exists: ${src}`);
      return undefined;
    }
    return [join(dirname(f), basename(f, extname(f))), src];
  }).filter((entry) => !!entry));
}

const entries = defineEntries([
  'hooks.ts',
  'main.ts',
  'worker/worker-entry.ts',
  'worker/worker-entry-prelude.ts',
  'contributions/asset-db/register.ts',
  'contributions/scene/index.ts',
  'contributions/server.ts',
  'contributions/builder/index.ts',
  'contributions/builder/hooks/index.ts',
  // ...(await readDirEntries('./src', 'contributions/inspector/exports')),
]);

export default defineConfig({
  build: {
    outDir: './dist',
    emptyOutDir: true,
    minify: false,
    sourcemap: 'inline',
    lib: {
      entry: entries,
      formats: ['cjs'],
    },
    rollupOptions: {
      external: [
        ...builtinModules,
        /^node:.*/,
        'fs-extra',
        'winston',
        'yaml',
        'vue',
        'rollup',
        /^@rollup\/.*/,
      ],
    },
  },
  plugins: [
    vue({
      template: {
        compilerOptions: {
          isCustomElement: (tag) => {
            if (tag.startsWith('ui-')) {
              return true;
            } else {
              return false;
            }
          },
        },
      },
    }),
    useEditorModules(),
    styleLocation(),
  ],
});

function useEditorModules(): Plugin {
  return {
    name: useEditorModules.name,

    resolveId(id, parent) {
      if (id.startsWith('@editor/') || id === 'cc') {
        return id;
      }
    },

    load(id, parent) {
      if (id.startsWith('@editor/') || id === 'cc') {
        const m = resolve(fileURLToPath(import.meta.url), '../src/utils/require-editor-module.ts').replace(/\\/g, '/');
        return {
          syntheticNamedExports: true,
          code: `import {requireEditorModule} from '${m}'; export default requireEditorModule('${id}');`,
        };
      }
    },
  };
}

function styleLocation(): Plugin {
  const styleModuleId = '@/style-location';
  let helperFileId = '';

  return {
    name: 'style-location',

    buildStart() {
      helperFileId = this.emitFile({
        type: 'asset',
        fileName: '.here',
        source: '',
      });
    },

    resolveId(source, importer, options) {
      if (source === styleModuleId) {
        return styleModuleId;
      }
    },

    load(id, options) {
      if (id === styleModuleId) {
        return `export default require('path').resolve(__dirname, import.meta.ROLLUP_FILE_URL_${helperFileId}, '../cc-extension-feb.css')`;
      }
    },

    resolveFileUrl({ relativePath, referenceId }) {
      if (referenceId === helperFileId) {
        return `require('path').resolve(__dirname, '${relativePath}')`;
      }
    },
  };
}
