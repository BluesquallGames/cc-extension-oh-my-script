import { afterEach, expect, it } from 'vitest';
import fs from 'fs-extra';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { Domain, readOmsDomainConfig } from '../src/domain.js';
import { UUIDManager } from '../src/uuid-manager.js';
import { OmsDomainConfigWatcher } from '../src/domain-config-watcher.js';
import { makeOmsEntryFileName } from '../src/utils/entry-id.js';
import { BuildRecord } from '../src/build-record.js';
import { normalizeProjectUserConfig } from '../src/config.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => fs.remove(dir)));
  tempDirs.length = 0;
});

it('reads legacy package.json OMS partitions but ignores package.json exports', async () => {
  const domainRoot = await makeTempDir();
  await fs.outputJson(join(domainRoot, 'package.json'), {
    exports: {
      './legacy': './oms/src/legacy.ts',
    },
    oms: {
      partitions: [
        { rootDir: 'legacy-src' },
      ],
    },
  });

  const config = await readOmsDomainConfig(domainRoot, {
    preferredSourceRoot: 'oms/src',
  });

  expect(config).toEqual({
    partitions: [
      { rootDir: 'legacy-src' },
    ],
    exports: {},
  });
});

it('lets oms.config.js provide exports and override legacy package.json partitions', async () => {
  const domainRoot = await makeTempDir();
  await fs.outputJson(join(domainRoot, 'package.json'), {
    exports: {
      './shared': './oms/src/package-shared.ts',
    },
    oms: {
      partitions: [
        { rootDir: 'legacy-src' },
      ],
    },
  });
  await fs.outputFile(join(domainRoot, 'oms.config.mjs'), [
    'export default {',
    '  partitions: [{ rootDir: "domain-src" }],',
    '  exports: {',
    '    shared: "./domain-src/config-shared.ts",',
    '    fresh: "./domain-src/fresh.ts",',
    '  },',
    '};',
  ].join('\n'));

  const config = await readOmsDomainConfig(domainRoot, {
    preferredSourceRoot: 'oms/src',
  });

  expect(config).toEqual({
    partitions: [
      { rootDir: 'domain-src' },
    ],
    exports: {
      shared: 'domain-src/config-shared.ts',
      fresh: 'domain-src/fresh.ts',
    },
  });
});

it('normalizes npm-style oms.config.js export keys for package-like imports', async () => {
  const domainRoot = await makeTempDir();
  await fs.outputFile(join(domainRoot, 'oms.config.mjs'), [
    'export default {',
    '  exports: {',
    '    ".": "./oms/src/index.ts",',
    '    "./abc": "./oms/src/abc.ts",',
    '  },',
    '};',
  ].join('\n'));

  const config = await readOmsDomainConfig(domainRoot, {
    preferredSourceRoot: 'oms/src',
  });

  expect(config.exports).toEqual({
    '.': 'oms/src/index.ts',
    abc: 'oms/src/abc.ts',
  });

  const domain = new Domain(
    'some-plugin',
    domainRoot,
    config.partitions,
    config.exports,
    new UUIDManager(domainRoot, join(domainRoot, 'uuids.json')),
    undefined,
  );

  expect(domain.generateTypingEntries()).toEqual([
    {
      moduleId: 'oms://some-plugin',
      packageName: '@oms-exports/some-plugin',
      source: join(domainRoot, 'oms/src/index.ts'),
    },
    {
      moduleId: 'oms://some-plugin/abc',
      packageName: '@oms-exports/some-plugin__abc',
      source: join(domainRoot, 'oms/src/abc.ts'),
    },
  ]);
});

it('uses exportPackageName as the public OMS package name', async () => {
  const domainRoot = await makeTempDir();
  await fs.outputFile(join(domainRoot, 'oms.config.mjs'), [
    'export default {',
    '  exportPackageName: "friendly-plugin",',
    '  exports: {',
    '    ".": "./oms/src/index.ts",',
    '    "./abc": "./oms/src/abc.ts",',
    '  },',
    '};',
  ].join('\n'));

  const config = await readOmsDomainConfig(domainRoot, {
    preferredSourceRoot: 'oms/src',
  });

  expect(config).toEqual({
    exportPackageName: 'friendly-plugin',
    partitions: [
      { rootDir: join('oms', 'src') },
    ],
    exports: {
      '.': 'oms/src/index.ts',
      abc: 'oms/src/abc.ts',
    },
  });

  const domain = new Domain(
    'some-plugin',
    domainRoot,
    config.partitions,
    config.exports,
    new UUIDManager(domainRoot, join(domainRoot, 'uuids.json')),
    undefined,
    config.exportPackageName,
  );

  expect(domain.exportPackageName).toBe('friendly-plugin');
  expect(domain.generateTypingEntries()).toEqual([
    {
      moduleId: 'oms://friendly-plugin',
      packageName: '@oms-exports/friendly-plugin',
      source: join(domainRoot, 'oms/src/index.ts'),
    },
    {
      moduleId: 'oms://friendly-plugin/abc',
      packageName: '@oms-exports/friendly-plugin__abc',
      source: join(domainRoot, 'oms/src/abc.ts'),
    },
  ]);

  const entrySpecs = domain.getEntrySpecs({
    regular: true,
    editor: false,
    headless: false,
  });
  expect(entrySpecs['friendly-plugin:.']?.exportId).toBe('friendly-plugin:.');
  expect(entrySpecs['friendly-plugin:abc']?.exportId).toBe('friendly-plugin:abc');
  expect(entrySpecs['some-plugin:.']).toBeUndefined();
});

it('creates public export entry specs for __oms_import__', async () => {
  const domainRoot = await makeTempDir();
  const domain = new Domain(
    'some-plugin',
    domainRoot,
    [{ rootDir: 'oms/src' }],
    {
      '.': 'oms/src/index.ts',
      a: 'oms/src/abc.ts',
    },
    new UUIDManager(domainRoot, join(domainRoot, 'uuids.json')),
    undefined,
  );

  const entrySpecs = domain.getEntrySpecs({
    regular: true,
    editor: false,
    headless: false,
  });

  expect(entrySpecs['some-plugin:.']?.exportId).toBe('some-plugin:.');
  expect(entrySpecs['some-plugin:a']?.exportId).toBe('some-plugin:a');
  expect(entrySpecs['some-plugin:a']?.source).toEqual({
    module: expect.stringContaining(join('oms', 'src', 'abc.ts')),
  });
});

it('maps colon export entry ids into portable export file names', () => {
  expect(makeOmsEntryFileName('some-plugin:a')).toBe('exports/some-plugin/a');
  expect(makeOmsEntryFileName('some-plugin:.')).toBe('exports/some-plugin/index');
});

it('writes colon export entry ids under exports/domain', async () => {
  const outDir = join(await makeTempDir(), 'out');
  const buildRecord = new BuildRecord({
    title: 'test-build',
    outDir,
    sourceMaps: false,
    config: normalizeProjectUserConfig({}),
    headless: false,
    treeShake: false,
  });

  const result = await buildRecord.rebuild({
    entries: {
      'some-plugin:a': 'export const value = 42;',
    },
    domains: {},
    uuidProvider: undefined,
    config: normalizeProjectUserConfig({}),
    profileBuildConfig: undefined,
  });

  expect(result.ok).toBe(true);
  expect(await fs.pathExists(join(outDir, 'exports', 'some-plugin', 'a.js'))).toBe(true);
  expect(await fs.pathExists(join(outDir, 'some-plugin_a.js'))).toBe(false);
});

it('resolves npm-style OMS import specifiers in bundle sources', async () => {
  const domainRoot = await makeTempDir();
  const outDir = join(await makeTempDir(), 'out');
  await fs.outputFile(join(domainRoot, 'oms', 'src', 'index.ts'), 'export const rootValue = 40;');
  await fs.outputFile(join(domainRoot, 'oms', 'src', 'abc.ts'), 'export const abcValue = 2;');
  const domain = new Domain(
    'some-plugin',
    domainRoot,
    [{ rootDir: 'oms/src' }],
    {
      '.': 'oms/src/index.ts',
      abc: 'oms/src/abc.ts',
    },
    new UUIDManager(domainRoot, join(domainRoot, 'uuids.json')),
    undefined,
    'friendly-plugin',
  );
  const buildRecord = new BuildRecord({
    title: 'test-build',
    outDir,
    sourceMaps: false,
    config: normalizeProjectUserConfig({}),
    headless: false,
    treeShake: false,
  });

  const result = await buildRecord.rebuild({
    entries: {
      consumer: [
        'import { rootValue } from "oms://friendly-plugin";',
        'import { abcValue } from "oms://friendly-plugin/abc";',
        'export const value = rootValue + abcValue;',
      ].join('\n'),
    },
    domains: {
      'some-plugin': domain,
    },
    uuidProvider: undefined,
    config: normalizeProjectUserConfig({}),
    profileBuildConfig: undefined,
  });

  expect(result.ok).toBe(true);
  const outputFile = join(outDir, 'consumer.js');
  expect(await fs.pathExists(outputFile)).toBe(true);
  const output = await readSnapshotText(outputFile);
  expect(output).toContain('const rootValue = 40;');
  expect(output).toContain('const abcValue = 2;');
  expect(output).toContain('const value = exports("value", rootValue + abcValue);');
});

it('builds public export entries without adding a synthetic default export', async () => {
  const domainRoot = await makeTempDir();
  const outDir = join(await makeTempDir(), 'out');
  await fs.outputFile(join(domainRoot, 'oms', 'src', 'font.ts'), 'export const bakeTextFieldFont = 42;');
  const domain = new Domain(
    'some-plugin',
    domainRoot,
    [{ rootDir: 'oms/src' }],
    {
      'editor/font': 'oms/src/font.ts',
    },
    new UUIDManager(domainRoot, join(domainRoot, 'uuids.json')),
    undefined,
  );
  const buildRecord = new BuildRecord({
    title: 'test-build',
    outDir,
    sourceMaps: false,
    config: normalizeProjectUserConfig({}),
    headless: false,
    treeShake: false,
  });

  const result = await buildRecord.rebuild({
    entries: Object.fromEntries(Object.entries(domain.getEntrySpecs({
      regular: true,
      editor: false,
      headless: false,
    })).map(([key, spec]) => [key, spec.source])),
    domains: {},
    uuidProvider: undefined,
    config: normalizeProjectUserConfig({}),
    profileBuildConfig: undefined,
  });

  expect(result.ok).toBe(true);
  const outputFile = join(outDir, 'exports', 'some-plugin', 'editor', 'font.js');
  expect(await fs.pathExists(outputFile)).toBe(true);
  expect(await readSnapshotText(outputFile)).toMatchSnapshot();
});

it('preserves public export entry default exports', async () => {
  const domainRoot = await makeTempDir();
  const outDir = join(await makeTempDir(), 'out');
  await fs.outputFile(join(domainRoot, 'oms', 'src', 'font.ts'), [
    'export const bakeTextFieldFont = 42;',
    'export default { bakeTextFieldFont };',
  ].join('\n'));
  const domain = new Domain(
    'some-plugin',
    domainRoot,
    [{ rootDir: 'oms/src' }],
    {
      'editor/font': 'oms/src/font.ts',
    },
    new UUIDManager(domainRoot, join(domainRoot, 'uuids.json')),
    undefined,
  );
  const buildRecord = new BuildRecord({
    title: 'test-build',
    outDir,
    sourceMaps: false,
    config: normalizeProjectUserConfig({}),
    headless: false,
    treeShake: false,
  });

  const result = await buildRecord.rebuild({
    entries: Object.fromEntries(Object.entries(domain.getEntrySpecs({
      regular: true,
      editor: false,
      headless: false,
    })).map(([key, spec]) => [key, spec.source])),
    domains: {},
    uuidProvider: undefined,
    config: normalizeProjectUserConfig({}),
    profileBuildConfig: undefined,
  });

  expect(result.ok).toBe(true);
  const outputFile = join(outDir, 'exports', 'some-plugin', 'editor', 'font.js');
  expect(await readSnapshotText(outputFile)).toMatchSnapshot();
});

it('reports the original Rollup load error instead of wrapping it as unexpected', async () => {
  const tempDir = await makeTempDir();
  const outDir = join(tempDir, 'out');
  const entryModule = join(tempDir, 'entry.js');
  await fs.outputFile(entryModule, 'export * from "missing-export-pkg/editor/font";');
  await fs.outputJson(join(tempDir, 'node_modules', 'missing-export-pkg', 'package.json'), {
    name: 'missing-export-pkg',
    type: 'module',
    exports: {
      './editor/font': './lib/editor/font.js',
    },
  });
  const buildRecord = new BuildRecord({
    title: 'test-build',
    outDir,
    sourceMaps: false,
    config: normalizeProjectUserConfig({}),
    headless: false,
    treeShake: false,
  });

  const result = await buildRecord.rebuild({
    entries: {
      broken: `export * from ${JSON.stringify(entryModule.replace(/\\/g, '/'))};`,
    },
    domains: {},
    uuidProvider: undefined,
    config: normalizeProjectUserConfig({}),
    profileBuildConfig: undefined,
  });

  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error.message).toContain('test-build failed: Could not load');
    expect(result.error.message).toContain('font.js');
    expect(result.error.message).not.toContain('Unexpected build error');
  }
});

it('reports syntax errors from entry source without wrapping them as unexpected', async () => {
  const outDir = join(await makeTempDir(), 'out');
  const buildRecord = new BuildRecord({
    title: 'test-build',
    outDir,
    sourceMaps: false,
    config: normalizeProjectUserConfig({}),
    headless: false,
    treeShake: false,
  });

  const result = await buildRecord.rebuild({
    entries: {
      broken: 'export const = ;',
    },
    domains: {},
    uuidProvider: undefined,
    config: normalizeProjectUserConfig({}),
    profileBuildConfig: undefined,
  });

  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error.message).toContain('test-build failed: oms-entry');
    expect(result.error.message).toContain('Unexpected token');
    expect(result.error.stack).toContain('RollupError');
    expect(result.error.stack).toContain('Caused by:');
    expect(result.error.message).not.toContain('Unexpected build error');
  }
});

it('watches domain oms.config.js changes', async () => {
  const domainRoot = await makeTempDir();
  await fs.outputFile(join(domainRoot, 'oms.config.mjs'), [
    'export default {',
    '  exports: { a: "./a.ts" },',
    '};',
  ].join('\n'));

  const watcher = new OmsDomainConfigWatcher({
    domainRoot,
    preferredSourceRoot: 'oms/src',
  });

  try {
    await expect(watcher.ready()).resolves.toMatchObject({
      partitions: [
        { rootDir: join('oms', 'src') },
      ],
      exports: {
        a: 'a.ts',
      },
    });

    await setTimeout(20);
    const updated = onceDomainConfigUpdated(watcher);
    await fs.outputFile(join(domainRoot, 'oms.config.mjs'), [
      'export default {',
      '  exports: { b: "./b.ts" },',
      '};',
    ].join('\n'));

    await expect(updated).resolves.toMatchObject({
      exports: {
        b: 'b.ts',
      },
    });
  } finally {
    await watcher.close();
  }
});

async function makeTempDir() {
  const dir = await fs.mkdtemp(join(tmpdir(), 'oms-domain-'));
  tempDirs.push(dir);
  return dir;
}

function onceDomainConfigUpdated(watcher: OmsDomainConfigWatcher) {
  return new Promise((resolve, reject) => {
    const timeout = globalThis.setTimeout(() => {
      watcher.off('configUpdated', onUpdated);
      reject(new Error('Timed out waiting for configUpdated'));
    }, 5000);
    const onUpdated = (config: unknown) => {
      globalThis.clearTimeout(timeout);
      resolve(config);
    };
    watcher.once('configUpdated', onUpdated);
  });
}

async function readSnapshotText(path: string) {
  return (await fs.readFile(path, 'utf8')).replace(/\r\n/g, '\n');
}
