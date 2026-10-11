import { join } from 'node:path';
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

const srcDir = join(import.meta.dirname, 'src');

export default defineConfig((env) => {
  return {
    build: {
      target: 'node22',
      lib: {
        entry: {
          main: join(srcDir, 'main.ts'),
          protocol: join(srcDir, 'protocol.ts'),
          cli: join(srcDir, 'cli.ts'),
        },
        formats: ['es'],
      },
      rollupOptions: {
        external: (id, importer, resolved) => {
          if (!importer) {
            return false;
          }
          if (resolved) {
            return false;
          }
          if (id.startsWith('node:')) {
            return true;
          }
          if (id.startsWith('./') || id.startsWith('../')) {
            return false;
          }
          return true;
        },
      },
      outDir: 'lib',
      emptyOutDir: true,
      sourcemap: true,
      minify: env.mode === 'production',
    },

    plugins: [
      dts({
      }),
    ],
  };
});
