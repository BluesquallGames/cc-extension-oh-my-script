import { afterEach, expect, it } from 'vitest';
import fs from 'fs-extra';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { Domain, type DomainProfile, readOmsDomainConfig } from '../src/domain.js';
import { UUIDManager } from '../src/uuid-manager.js';
import { OmsDomainConfigWatcher } from '../src/domain-config-watcher.js';
import { makeOmsEntryFileName } from '../src/utils/entry-id.js';
import { BuildRecord } from '../src/build-record.js';
import { normalizeProjectUserConfig } from '../src/config.js';

const tempDirs: string[] = [];
const developmentConfigContext = { mode: 'development' };
const testDomainProfile: DomainProfile = {
  id: 'test',
  sourceMatcher: () => true,
  bundle: {
    idSuffix: '',
    indexPreStem: 'index-pre',
    indexPostStem: 'index',
  },
};

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => fs.remove(dir)));
  tempDirs.length = 0;
});

it(('loads object, synchronous function, and asynchronous function configs '
  + 'with the supplied context'), async () => {
  /// @case
  /// Three domains export an object, a synchronous config function, and an asynchronous config
  /// function; function configs read a custom mode string.
  /// @expect
  /// Every export form remains compatible and both function forms receive the exact caller-provided
  /// mode without enum coercion or fallback.
  const objectDomain = await makeTempDir();
  const syncDomain = await makeTempDir();
  const asyncDomain = await makeTempDir();
  await fs.outputFile(join(objectDomain, 'oms.config.mjs'),
    'export default { exports: { object: "./object.ts" } };');
  await fs.outputFile(join(syncDomain, 'oms.config.mjs'), [
    'export default ({ mode }) => ({',
    '  exports: { sync: `./${mode}.ts` },',
    '});',
  ].join('\n'));
  await fs.outputFile(join(asyncDomain, 'oms.config.mjs'), [
    'export default async ({ mode }) => ({',
    '  exportPackageName: mode,',
    '  exports: { async: "./async.ts" },',
    '});',
  ].join('\n'));
  const context = { mode: 'custom-mode' };

  await expect(readOmsDomainConfig(objectDomain, {
    preferredSourceRoot: 'oms/src',
    context,
  })).resolves.toMatchObject({ exports: { object: 'object.ts' } });
  await expect(readOmsDomainConfig(syncDomain, {
    preferredSourceRoot: 'oms/src',
    context,
  })).resolves.toMatchObject({ exports: { sync: 'custom-mode.ts' } });
  await expect(readOmsDomainConfig(asyncDomain, {
    preferredSourceRoot: 'oms/src',
    context,
  })).resolves.toMatchObject({
    exportPackageName: 'custom-mode',
    exports: { async: 'async.ts' },
  });
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
    context: developmentConfigContext,
  });

  expect(config).toEqual({
    partitions: [
      { rootDir: 'legacy-src' },
    ],
    exports: {},
  });
});

it(('lets oms.config.js provide exports and override legacy package.json '
  + 'partitions'), async () => {
  const domainRoot = await makeTempDir();
  await fs.outputJson(join(domainRoot, 'package.json'), {
    exports: {
      './shared': './oms/src/package-shared.ts',
    },
    oms: {
      partitions: [{ rootDir: 'legacy-src' }],
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
    context: developmentConfigContext,
  });

  expect(config).toEqual({
    partitions: [{ rootDir: 'domain-src' }],
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
    context: developmentConfigContext,
  });

  expect(config.exports).toEqual({
    '.': 'oms/src/index.ts',
    'abc': 'oms/src/abc.ts',
  });

  const domain = new Domain(
    'some-plugin',
    domainRoot,
    config.partitions,
    config.exports,
    new UUIDManager(domainRoot, join(domainRoot, 'uuids.json')),
    [testDomainProfile],
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
    context: developmentConfigContext,
  });

  expect(config).toEqual({
    exportPackageName: 'friendly-plugin',
    partitions: [
      { rootDir: join('oms', 'src') },
    ],
    exports: {
      '.': 'oms/src/index.ts',
      'abc': 'oms/src/abc.ts',
    },
  });

  const domain = new Domain(
    'some-plugin',
    domainRoot,
    config.partitions,
    config.exports,
    new UUIDManager(domainRoot, join(domainRoot, 'uuids.json')),
    [testDomainProfile],
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

  const entrySpecs = domain.getEntrySpecs(testDomainProfile.id);
  expect(entrySpecs['friendly-plugin:.']?.exportId).toBe('friendly-plugin:.');
  expect(entrySpecs['friendly-plugin:abc']?.exportId).toBe('friendly-plugin:abc');
  expect(entrySpecs['some-plugin:.']).toBeUndefined();
});

it('rejects source files in a sibling directory sharing the source root prefix', async () => {
  /// @case
  /// A domain accepts files under src, but a sibling src-extra directory shares its path prefix.
  /// @expect
  /// Adding a file under src succeeds; adding a sibling file fails before it enters any bundle.
  const domainRoot = await makeTempDir();
  const source = join(domainRoot, 'src/constants.ts');
  const sibling = join(domainRoot, 'src-extra/constants.ts');
  await fs.outputFile(source, 'export const value = 1;');
  await fs.outputFile(sibling, 'export const value = 2;');
  const domain = new Domain(
    'test-domain',
    domainRoot,
    [{ rootDir: 'src' }],
    {},
    new UUIDManager(domainRoot, join(domainRoot, 'uuids.json')),
    [testDomainProfile],
  );

  await expect(domain.addSourceFile(source, true)).resolves.toBe(false);
  await expect(domain.addSourceFile(sibling, true)).rejects.toThrow('not found in domain');
});

it('normalizes project peer import package names from project config', () => {
  const config = normalizeProjectUserConfig({
    resolve: {
      projectPeers: [
        'peer-pkg',
        '@scope/shared',
        'peer-pkg',
        './invalid',
        '@scope/shared/runtime',
      ],
    },
  });

  expect(config.resolve.projectPeers).toEqual([
    'peer-pkg',
    '@scope/shared',
  ]);
});

it('normalizes project define and env options', () => {
  /// @case
  /// 1. A project config declares Vite-like define values and env loading options.
  /// 2. The env prefix includes a duplicate, an empty prefix, and a non-string value.
  /// @expect
  /// Define values are converted to JavaScript expressions and env options keep only usable
  /// prefixes.
  const config = normalizeProjectUserConfig({
    mode: 'staging',
    envDir: 'config-env',
    envPrefix: [
      'OMS_',
      'PUBLIC_',
      'OMS_',
      '',
      1,
    ],
    define: {
      __OMS_STRING__: JSON.stringify('value'),
      __OMS_BOOL__: true,
      __OMS_OBJECT__: { nested: 1 },
      __OMS_UNDEFINED__: undefined,
    },
  });

  expect(config.mode).toBe('staging');
  expect(config.envDir).toBe('config-env');
  expect(config.envPrefix).toEqual(['OMS_', 'PUBLIC_']);
  expect(config.define).toEqual({
    __OMS_STRING__: '"value"',
    __OMS_BOOL__: 'true',
    __OMS_OBJECT__: '{"nested":1}',
    __OMS_UNDEFINED__: 'undefined',
  });
});

it(('normalizes default and headless profiles without accepting the legacy '
  + 'top-level headless option'), () => {
  /// @case
  /// 1. A project config declares a default exclusion, an unsupported default include, and an
  /// explicitly empty headless include.
  /// 2. A second config uses only the removed top-level headless option.
  /// @expect
  /// The normalized profiles preserve the new filtering semantics, keep default.include undefined,
  /// and do not enable legacy headless.
  const config = normalizeProjectUserConfig({
    profiles: {
      default: {
        exclude: ['src/authority/**'],
        include: ['src/client/**'],
      },
      headless: {
        include: [],
        exclude: ['src/client/**'],
        build: {
          target: 'chrome80',
        },
      },
    },
  } as Parameters<typeof normalizeProjectUserConfig>[0]);

  expect(config.profiles.default.include).toBeUndefined();
  expect(config.profiles.default.exclude?.('src/authority/agent.component.ts')).toBe(true);
  expect(config.profiles.default.exclude?.('src/shared/value.component.ts')).toBe(false);
  expect(config.profiles.headless?.include?.('src/shared/value.component.ts')).toBe(false);
  expect(config.profiles.headless?.exclude?.('src/client/view.component.ts')).toBe(true);
  expect(config.profiles.headless?.build.target).toBe('chrome80');

  const unfilteredHeadlessConfig = normalizeProjectUserConfig({
    profiles: {
      headless: {},
    },
  });
  expect(unfilteredHeadlessConfig.profiles.headless?.include).toBeUndefined();

  const legacyConfig = normalizeProjectUserConfig({
    headless: true,
  } as Parameters<typeof normalizeProjectUserConfig>[0]);
  expect(legacyConfig.profiles.headless).toBeUndefined();
});

it('creates public export entry specs for __oms_import__', async () => {
  const domainRoot = await makeTempDir();
  const domain = new Domain(
    'some-plugin',
    domainRoot,
    [{ rootDir: 'oms/src' }],
    {
      '.': 'oms/src/index.ts',
      'a': 'oms/src/abc.ts',
    },
    new UUIDManager(domainRoot, join(domainRoot, 'uuids.json')),
    [testDomainProfile],
  );

  const entrySpecs = domain.getEntrySpecs(testDomainProfile.id);

  expect(entrySpecs['some-plugin:.']?.exportId).toBe('some-plugin:.');
  expect(entrySpecs['some-plugin:a']?.exportId).toBe('some-plugin:a');
  expect(entrySpecs['some-plugin:a']?.source).toEqual({
    module: expect.stringContaining(join('oms', 'src', 'abc.ts')),
  });
});

it(('uses arbitrary profile descriptors and selects editor entries per '
  + 'build request'), async () => {
  /// @case
  /// 1. A domain registers profiles whose ids and entry stems are unrelated to default or headless.
  /// 2. The same profile is requested once without editor entries and once with its full editor
  /// overlay.
  /// 3. Dynamic exports are requested with undefined, true, and false.
  /// @expect
  /// Primary source matching uses only each descriptor, editor overlays restore unmatched and
  /// editor-only components, and dynamic exports follow the explicit switch.
  const domainRoot = await makeTempDir();
  const profile = {
    id: 'server',
    sourceMatcher: (path: string) => path.replace(/\\/g, '/').startsWith('src/shared/'),
    bundle: {
      idSuffix: '.server',
      indexPreStem: 'index-pre.server',
      indexPostStem: 'index.server',
    },
  };
  const clientProfile = {
    id: 'client',
    sourceMatcher: (path: string) => path.replace(/\\/g, '/').startsWith('src/client/'),
    bundle: {
      idSuffix: '.client',
      indexPreStem: 'index-pre.client',
      indexPostStem: 'index.client',
    },
  };
  const domain = new Domain(
    'arbitrary',
    domainRoot,
    [{ rootDir: 'src' }],
    { '.': 'src/dynamic-export.ts' },
    new UUIDManager(domainRoot, join(domainRoot, 'uuids.json')),
    [profile, clientProfile],
  );
  const files = {
    runtimeIndex: join(domainRoot, 'src', 'index.server.ts'),
    editorIndex: join(domainRoot, 'src', 'index.server.editor.ts'),
    runtimeComponent: join(domainRoot, 'src', 'shared', 'runtime.component.ts'),
    editorComponent: join(domainRoot, 'src', 'shared', 'tool.component.editor.ts'),
    excludedComponent: join(domainRoot, 'src', 'client', 'view.component.ts'),
    clientEditorComponent: join(domainRoot, 'src', 'client', 'panel.component.editor.ts'),
  };
  for (const file of Object.values(files)) {
    await fs.outputFile(file, 'export {};');
    await domain.addSourceFile(file, true);
  }

  const runtimeEntries = domain.getEntrySpecs(profile.id);
  expect(runtimeEntries['bundle-arbitrary.server']?.source).toEqual(expect
    .stringContaining(files.runtimeIndex.replace(/\\/g, '/')));
  expect(runtimeEntries['bundle-arbitrary.server']?.source).toEqual(expect
    .stringContaining(files.runtimeComponent.replace(/\\/g, '/')));
  expect(runtimeEntries['bundle-arbitrary.server']?.source).not.toEqual(expect
    .stringContaining(files.excludedComponent.replace(/\\/g, '/')));
  expect(runtimeEntries['bundle-arbitrary.server.editor']).toBeUndefined();
  expect(runtimeEntries['arbitrary:.']?.exportId).toBe('arbitrary:.');

  const editorEntries = domain.getEntrySpecs(profile.id, { editor: true, dynamicExports: true });
  expect(editorEntries['bundle-arbitrary.server.editor']?.source).toEqual(expect
    .stringContaining(files.editorIndex.replace(/\\/g, '/')));
  expect(editorEntries['bundle-arbitrary.server.editor']?.source).toEqual(expect
    .stringContaining(files.editorComponent.replace(/\\/g, '/')));
  expect(editorEntries['bundle-arbitrary.server.editor']?.source).toEqual(expect
    .stringContaining(files.excludedComponent.replace(/\\/g, '/')));
  expect(editorEntries['bundle-arbitrary.server.editor']?.source).toEqual(expect
    .stringContaining(files.clientEditorComponent.replace(/\\/g, '/')));
  expect(editorEntries['bundle-arbitrary.server.editor']?.source).not.toEqual(expect
    .stringContaining(files.runtimeComponent.replace(/\\/g, '/')));
  expect(editorEntries['arbitrary:.']?.exportId).toBe('arbitrary:.');
  expect(domain.getImplicitEntries(profile.id)).not.toContain(files.editorComponent);
  expect(domain.getImplicitEntries(profile.id, { editor: true })).toContain(files.editorComponent);
  const clientEditorEntry = domain.getEntrySpecs(clientProfile.id, { editor: true })[
    'bundle-arbitrary.client.editor']?.source;
  expect(clientEditorEntry).toEqual(expect.stringContaining(files.runtimeComponent
    .replace(/\\/g, '/')));
  expect(clientEditorEntry).toEqual(expect.stringContaining(files.editorComponent
    .replace(/\\/g, '/')));
  expect(clientEditorEntry).toEqual(expect.stringContaining(files.clientEditorComponent
    .replace(/\\/g, '/')));
  expect(clientEditorEntry).not.toEqual(expect.stringContaining(files.excludedComponent
    .replace(/\\/g, '/')));

  const entriesWithoutDynamicExports = domain.getEntrySpecs(profile.id, { dynamicExports: false });
  expect(entriesWithoutDynamicExports['arbitrary:.']).toBeUndefined();
});

it('emits dynamic exports independently from profile registration', async () => {
  /// @case
  /// 1. A domain registers one component profile and exposes a dynamic export.
  /// 2. A build requests a different profile id with dynamic exports omitted, enabled, and
  /// disabled.
  /// @expect
  /// The unknown profile contributes no component bundle, while dynamic exports are emitted unless
  /// explicitly disabled.
  const domainRoot = await makeTempDir();
  const domain = new Domain(
    'extension',
    domainRoot,
    [{ rootDir: 'src' }],
    { '.': 'src/dynamic-export.ts' },
    new UUIDManager(domainRoot, join(domainRoot, 'uuids.json')),
    [testDomainProfile],
  );

  const defaultEntries = domain.getEntrySpecs('unregistered');
  expect(defaultEntries['bundle-extension']).toBeUndefined();
  expect(defaultEntries['extension:.']?.exportId).toBe('extension:.');
  expect(domain.getEntrySpecs('unregistered', { dynamicExports: true })['extension:.']
    ?.exportId).toBe('extension:.');
  expect(domain.getEntrySpecs('unregistered', { dynamicExports: false })['extension:.'])
    .toBeUndefined();
});

it('maps colon export entry ids into portable export file names', () => {
  expect(makeOmsEntryFileName('some-plugin:a')).toBe('exports/some-plugin/a');
  expect(makeOmsEntryFileName('some-plugin:.')).toBe('exports/some-plugin/index');
});

it('writes colon export entry ids under exports/domain', async () => {
  const outDir = join(await makeTempDir(), 'out');
  const buildRecord = new BuildRecord({
    projectRoot: dirname(outDir),
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

it('removes obsolete JavaScript and sourcemap outputs across rebuilds', async () => {
  /// @case
  /// 1. A build with external sourcemaps emits a first entry.
  /// 2. A non-empty rebuild replaces it with a second entry, followed by an empty rebuild.
  /// @expect
  /// Every JavaScript file and external sourcemap owned by the prior build is removed after it
  /// becomes obsolete.
  const outDir = join(await makeTempDir(), 'out');
  const config = normalizeProjectUserConfig({});
  const buildRecord = new BuildRecord({
    projectRoot: dirname(outDir),
    title: 'test-build',
    outDir,
    sourceMaps: true,
    config,
    headless: false,
    treeShake: false,
  });
  const commonBuildOptions = {
    domains: {},
    uuidProvider: undefined,
    config,
    profileBuildConfig: undefined,
  };

  await expect(buildRecord.rebuild({
    ...commonBuildOptions,
    entries: {
      first: 'export const first = 1;',
    },
  })).resolves.toMatchObject({ ok: true });
  await expect(fs.pathExists(join(outDir, 'first.js'))).resolves.toBe(true);
  await expect(fs.pathExists(join(outDir, 'first.js.map'))).resolves.toBe(true);

  await expect(buildRecord.rebuild({
    ...commonBuildOptions,
    entries: {
      second: 'export const second = 2;',
    },
  })).resolves.toMatchObject({ ok: true });
  await expect(fs.pathExists(join(outDir, 'first.js'))).resolves.toBe(false);
  await expect(fs.pathExists(join(outDir, 'first.js.map'))).resolves.toBe(false);
  await expect(fs.pathExists(join(outDir, 'second.js'))).resolves.toBe(true);
  await expect(fs.pathExists(join(outDir, 'second.js.map'))).resolves.toBe(true);

  await expect(buildRecord.rebuild({
    ...commonBuildOptions,
    entries: {},
  })).resolves.toMatchObject({ ok: true });
  await expect(fs.pathExists(join(outDir, 'second.js'))).resolves.toBe(false);
  await expect(fs.pathExists(join(outDir, 'second.js.map'))).resolves.toBe(false);
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
      'abc': 'oms/src/abc.ts',
    },
    new UUIDManager(domainRoot, join(domainRoot, 'uuids.json')),
    [testDomainProfile],
    'friendly-plugin',
  );
  const buildRecord = new BuildRecord({
    projectRoot: dirname(outDir),
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
  await fs.outputFile(join(domainRoot, 'oms', 'src', 'font.ts'),
    'export const bakeTextFieldFont = 42;');
  const domain = new Domain(
    'some-plugin',
    domainRoot,
    [{ rootDir: 'oms/src' }],
    {
      'editor/font': 'oms/src/font.ts',
    },
    new UUIDManager(domainRoot, join(domainRoot, 'uuids.json')),
    [testDomainProfile],
  );
  const buildRecord = new BuildRecord({
    projectRoot: dirname(outDir),
    title: 'test-build',
    outDir,
    sourceMaps: false,
    config: normalizeProjectUserConfig({}),
    headless: false,
    treeShake: false,
  });

  const result = await buildRecord.rebuild({
    entries: Object.fromEntries(Object.entries(domain.getEntrySpecs(testDomainProfile.id,
      { editor: true })).map(([key, spec]) => [key, spec.source])),
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
    [testDomainProfile],
  );
  const buildRecord = new BuildRecord({
    projectRoot: dirname(outDir),
    title: 'test-build',
    outDir,
    sourceMaps: false,
    config: normalizeProjectUserConfig({}),
    headless: false,
    treeShake: false,
  });

  const result = await buildRecord.rebuild({
    entries: Object.fromEntries(Object.entries(domain.getEntrySpecs(testDomainProfile.id,
      { editor: true })).map(([key, spec]) => [key, spec.source])),
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
    projectRoot: dirname(outDir),
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
  /// @case
  /// An in-memory entry contains invalid JavaScript and is parsed by the same Babel stage as other
  /// loaded modules.
  /// @expect
  /// The build reports the entry, original syntax error and offending source without replacing them
  /// with a generic error.
  const outDir = join(await makeTempDir(), 'out');
  const buildRecord = new BuildRecord({
    projectRoot: dirname(outDir),
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
    expect(result.error.message).toContain('test-build failed:');
    expect(result.error.message).toContain('oms-entry');
    expect(result.error.message).toContain('Unexpected token');
    expect(result.error.message).toContain('export const = ;');
    expect(result.error.stack).toContain('SyntaxError');
    expect(result.error.message).not.toContain('Unexpected build error');
  }
});

it('watches domain oms.config.js changes', async () => {
  /// @case
  /// A development-mode domain watcher reloads a changed function config that selects its export
  /// path from context.mode.
  /// @expect
  /// Both the initial read and hot reload receive the watcher's creation mode instead of changing
  /// context or using a fallback.
  const domainRoot = await makeTempDir();
  await fs.outputFile(join(domainRoot, 'oms.config.mjs'), [
    'export default ({ mode }) => ({',
    '  exports: { a: `./a-${mode}.ts` },',
    '});',
  ].join('\n'));

  const watcher = new OmsDomainConfigWatcher({
    domainRoot,
    preferredSourceRoot: 'oms/src',
    context: developmentConfigContext,
  });

  try {
    await expect(watcher.ready()).resolves.toMatchObject({
      partitions: [
        { rootDir: join('oms', 'src') },
      ],
      exports: {
        a: 'a-development.ts',
      },
    });

    await setTimeout(20);
    const updated = onceDomainConfigUpdated(watcher);
    await fs.outputFile(join(domainRoot, 'oms.config.mjs'), [
      'export default ({ mode }) => ({',
      '  exports: { b: `./b-${mode}.ts` },',
      '});',
    ].join('\n'));

    await expect(updated).resolves.toMatchObject({
      exports: {
        b: 'b-development.ts',
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
