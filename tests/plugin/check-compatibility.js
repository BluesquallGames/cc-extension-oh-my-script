import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const require = createRequire(resolve(root, 'packages/build-core/package.json'));
const ts = require('typescript');
const options = {
  strict: true,
  noEmit: true,
  skipLibCheck: true,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  paths: {
    vite: [resolve(root, 'packages/build-core/node_modules/vite/dist/node/index.d.ts')],
    '@oms/plugin': [resolve(root, 'packages/plugin/lib/index.d.ts')],
  },
};
const program = ts.createProgram([resolve(import.meta.dirname, 'artifacts/compatibility.ts')], options);
const diagnostics = ts.getPreEmitDiagnostics(program);
if (diagnostics.length) {
  process.stderr.write(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: (file) => file,
    getCurrentDirectory: () => root,
    getNewLine: () => '\n',
  }));
  process.exitCode = 1;
} else {
  process.stdout.write('OMS plugin subset is assignable to the installed Vite Plugin type.\n');
}
