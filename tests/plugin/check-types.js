import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const testDir = dirname(fileURLToPath(import.meta.url));
const artifactsDir = join(testDir, 'artifacts');
const repoDir = resolve(testDir, '../..');
// Use the repository's existing compiler and the package's declared Rollup dependency.
const require = createRequire(join(repoDir, 'packages/build-core/package.json'));
const ts = require('typescript');
const packageDir = process.argv[2] ? resolve(process.argv[2]) : join(repoDir, 'packages/plugin');
const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
assert.deepEqual(manifest.files, ['lib']);
assert.deepEqual(Object.keys(manifest.dependencies), ['rollup']);
assert.equal(manifest.exports, './lib/index.js');
const temporaryDir = mkdtempSync(join(tmpdir(), 'oms-plugin-consumer-'));

try {
  const installDir = join(temporaryDir, 'node_modules/@oms/plugin');
  mkdirSync(installDir, { recursive: true });
  cpSync(join(packageDir, 'package.json'), join(installDir, 'package.json'));
  cpSync(join(packageDir, 'lib'), join(installDir, 'lib'), { recursive: true });
  for (const file of ['plugin.ts', 'isolated.ts', 'commonjs.cts', 'javascript.js', 'runtime.js']) {
    cpSync(join(artifactsDir, file), join(temporaryDir, file));
  }
  cpSync(dirname(require.resolve('rollup/package.json')), join(temporaryDir, 'node_modules/rollup'), { recursive: true });
  const rollupRequire = createRequire(require.resolve('rollup/package.json'));
  cpSync(dirname(rollupRequire.resolve('@types/estree/package.json')), join(temporaryDir, 'node_modules/@types/estree'), { recursive: true });
  writeFileSync(join(temporaryDir, 'package.json'), JSON.stringify({ type: 'module' }));

  let checks = 0;
  for (const [mode, module, moduleResolution] of [
    ['Node16', ts.ModuleKind.Node16, ts.ModuleResolutionKind.Node16],
    ['NodeNext', ts.ModuleKind.NodeNext, ts.ModuleResolutionKind.NodeNext],
    ['Bundler', ts.ModuleKind.Preserve, ts.ModuleResolutionKind.Bundler],
  ]) {
    for (const scenario of ['plugin', 'isolated', 'commonjs', 'javascript']) {
      const roots = [join(temporaryDir, `${scenario}.${scenario === 'commonjs' ? 'cts' : scenario === 'javascript' ? 'js' : 'ts'}`)];
      const options = {
        module, moduleResolution,
        target: ts.ScriptTarget.ES2022,
        lib: ['lib.es2022.d.ts', 'lib.esnext.disposable.d.ts'],
        types: [],
        strict: true,
        exactOptionalPropertyTypes: true,
        noUncheckedIndexedAccess: true,
        verbatimModuleSyntax: true,
        noEmit: true,
        skipLibCheck: false,
        allowJs: true,
        checkJs: true,
      };
      const host = ts.createCompilerHost(options);
      host.getCurrentDirectory = () => temporaryDir;
      const program = ts.createProgram(roots, options, host);
      const diagnostics = ts.getPreEmitDiagnostics(program);
      if (diagnostics.length > 0) {
        process.stderr.write(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
          getCanonicalFileName: (file) => file,
          getCurrentDirectory: () => temporaryDir,
          getNewLine: () => '\n',
        }));
        throw new Error(`${mode}/${scenario} failed`);
      }
      checks++;
    }
  }
  await import(pathToFileURL(join(temporaryDir, 'runtime.js')).href);
  process.stdout.write(`Passed ${checks} independent public type-consumption checks (TypeScript ${ts.version}).\n`);
} finally {
  // The absolute temp directory is created by mkdtemp above and never user-supplied.
  assert.equal(dirname(resolve(temporaryDir)), resolve(tmpdir()));
  rmSync(temporaryDir, { recursive: true, force: true });
}
