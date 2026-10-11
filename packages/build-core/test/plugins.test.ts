import { afterEach, expect, it } from 'vitest';
import fs from 'fs-extra';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { OmsBuilder } from '../src/oms-builder.js';
import { ServerContext } from '../src/server-context.js';
import type {
  PassiveBuildEndInfo,
  ClientInvocationMethodId,
  ServerInvocationMethodId,
} from '../src/protocol.js';
import { Ipc, InvocationDirection } from '../src/protocol.js';
import { build as buildVite } from 'vite';

const directories: string[] = [];

async function createProject() {
  const project = await fs.mkdtemp(join(tmpdir(), 'oms-plugin-'));
  directories.push(project);
  await fs.outputJson(join(project, 'package.json'), { type: 'module' });
  return project;
}

function createBuilder(project: string) {
  const ipc = new Ipc<ServerInvocationMethodId, ClientInvocationMethodId>({
    send(message) {
      if (message.direction === InvocationDirection.call) {
        queueMicrotask(() => ipc.dispatch({
          direction: InvocationDirection.returns,
          invocationId: message.invocationId,
          ok: true,
          returnValue: undefined,
        }));
      }
    },
  });
  return new OmsBuilder(new ServerContext(ipc), { project });
}

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    if (dirname(resolve(directory)) !== resolve(tmpdir())) {
      throw new Error('Unexpected test directory');
    }
    await fs.remove(directory);
  }
});

function nextPassiveBuild(builder: OmsBuilder) {
  return new Promise<PassiveBuildEndInfo>((done, reject) => {
    const listener = (info: PassiveBuildEndInfo) => {
      clearTimeout(timeout);
      done(info);
    };
    const timeout = setTimeout(() => {
      builder.off('passive-build-end', listener);
      reject(new Error('Missing dependency rebuild'));
    }, 5000);
    builder.once('passive-build-end', listener);
  });
}

it.each(['alias', 'pre'] as const)(
  'applies %s before built-in resolution and preserves loader precedence', async (priority) => {
  /// @case
  /// Alias or pre plugins handle domain, Node builtin and project-peer specifiers; two pre plugins
  /// compete and a normal plugin tries to replace a builtin UUID module.
  /// @expect
  /// Alias precedes pre; pre precedes builtins and keeps declaration order; builtin UUID loading
  /// precedes normal loading, whose virtual modules remain available.
    const project = await createProject();
    const specifiers = ['oms://unregistered/value', 'node:fs', '#oms-peer:unlisted'];
    await fs.outputFile(join(project, 'assets/pre.png'), 'asset');
    await fs.outputJson(join(project, 'assets/pre.png.meta'), { uuid: 'unused-pre-uuid' });
    await fs.outputFile(join(project, 'assets/core.png'), 'asset');
    await fs.outputJson(join(project, 'assets/core.png.meta'), { uuid: 'core-uuid' });
    await fs.outputFile(join(project, 'src/index.ts'), [
      ...specifiers.map((specifier, index) => `import value${index} from ${JSON.stringify(
        specifier)};`),
      'import preUuid from "../assets/pre.png?uuid";',
      'import coreUuid from "../assets/core.png?uuid";',
      'import normal from "test:normal";',
      'export const values = [value0, value1, value2, preUuid, coreUuid, normal];',
    ].join('\n'));
    await fs.outputFile(join(project, 'src/index.headless.ts'),
      'export { values } from "./index.js";');
    const alias = priority === 'alias'
      ? Object.fromEntries(specifiers.map((specifier) => [
        specifier,
        'test:aliased']))
      : {};
    await fs.outputFile(join(project, 'oms.config.js'), [
      `const specifiers = ${JSON.stringify(specifiers)};`,
      `const usesAlias = ${priority === 'alias'};`,
      'export default {',
      `resolve: { alias: ${JSON.stringify(alias)} },`,
      'profiles: { headless: { include: [] } },',
      'plugins: [',
      '{ name: "test:normal",',
      ('resolveId(source) { if (source === "test:normal" || '
        + 'specifiers.includes(source)) return "\\0test:normal"; },'),
      ('load(id) { if (id === "\\0test:normal") return "export default '
        + '\\"normal\\";"; if (id.endsWith("core.png")) return "export default '
        + '\\"wrong-normal-uuid\\";"; }'),
      '},',
      '{ name: "test:first-pre", enforce: "pre",',
      'resolveId(source) {',
      ('if (usesAlias && specifiers.includes(source)) this.error("Alias must '
        + 'run before pre");'),
      ('if (source === "test:aliased" || specifiers.includes(source)) return '
        + '"\\0test:first-pre";'),
      '},',
      ('load(id) { if (id === "\\0test:first-pre") return "export default '
        + '\\"first-pre\\";"; if (id.endsWith("pre.png")) return "export default '
        + '\\"pre-uuid\\";"; }'),
      '},',
      '{ name: "test:second-pre", enforce: "pre",',
      ('resolveId(source) { if (source === "test:aliased" || '
        + 'specifiers.includes(source)) return "\\0test:second-pre"; },'),
      ('load(id) { if (id === "\\0test:second-pre") return "export default '
        + '\\"wrong-second-pre\\";"; }'),
      '}',
      '] };',
    ].join('\n'));
    const builder = createBuilder(project);
    try {
      await builder.updateBuildOptions({ extensionBuildOptions: [] });
      const result = await builder.rebuild();
      expect(result, JSON.stringify(result, (key, value) => key === 'stack' ? undefined : value))
        .toMatchObject({ default: { ok: true }, headless: { ok: true } });
      const buildDir = join(project, 'build');
      await builder.buildProd({
        buildDir,
        debug: true,
        sourceMaps: false,
        platform: 'nodejs',
        headless: true,
      });
      for (const outDir of [join(project, 'temp/oms/out-headless'), join(buildDir, 'oms')]) {
        await fs.outputJson(join(outDir, 'package.json'), { type: 'module' });
        const namespace = await import(pathToFileURL(join(outDir, 'bundle-main.headless.js')).href);
        expect(namespace.values).toEqual([
          'first-pre',
          'first-pre',
          'first-pre',
          'pre-uuid',
          'core-uuid',
          'normal',
        ]);
      }
    } finally {
      await builder.close();
    }
  });

it(('imports asset root UUIDs from relative, absolute, aliased and '
  + 'virtual-module specifiers'), async () => {
  /// @case
  /// Source and a plugin-generated virtual module import assets using ?uuid in development and
  /// production.
  /// @expect
  /// OMS exports each metadata root UUID, never substitutes a subasset UUID, and requires no
  /// generated input files.
  const project = await createProject();
  const asset = join(project, 'assets/images/example.png');
  await fs.outputFile(asset, 'asset contents are not JavaScript');
  await fs.outputJson(`${asset}.meta`, {
    uuid: 'asset-root-uuid',
    subMetas: {
      sprite: {
        uuid: 'subasset-uuid-must-not-be-selected',
      },
    },
  });
  await fs.outputFile(join(project, 'src/index.ts'), [
    'import relative from "../assets/images/example.png?uuid";',
    `import absolute from ${JSON.stringify(asset.replaceAll('\\', '/') + '?uuid')};`,
    'import aliased from "@image?uuid";',
    'import virtual from "generated-uuid";',
    'export const values = [relative, absolute, aliased, virtual];',
  ].join('\n'));
  await fs.outputFile(join(project, 'src/index.headless.ts'),
    'export { values } from "./index.js";');
  await fs.outputFile(join(project, 'oms.config.js'), [
    `const importer = ${JSON.stringify(join(project, 'src/view.custom'))};`,
    'export default {',
    'profiles: { headless: { include: [] } },',
    `resolve: { alias: { "@image": ${JSON.stringify(asset)} } },`,
    'plugins: [{ name: "test:uuid-virtual", enforce: "pre",',
    'async resolveId(source, parent, options) {',
    'if (source === "generated-uuid") return "\\0generated-uuid";',
    ('if (parent === "\\0generated-uuid") return this.resolve(source, '
      + 'importer, options);'),
    '},',
    ('load(id) { if (id === "\\0generated-uuid") return "export { default } '
      + 'from \\"../assets/images/example.png?uuid\\";"; }'),
    '}] };',
  ].join('\n'));
  const builder = createBuilder(project);
  try {
    await builder.updateBuildOptions({ extensionBuildOptions: [] });
    expect(await builder.rebuild()).toMatchObject({ default: { ok: true },
      headless: { ok: true } });
    const buildDir = join(project, 'build');
    await builder.buildProd({
      buildDir,
      debug: true,
      sourceMaps: false,
      platform: 'web',
      headless: false,
    });
    for (const outDir of [join(project, 'temp/oms/out'), join(buildDir, 'oms')]) {
      const code = await fs.readFile(join(outDir, 'bundle-main.js'), 'utf8');
      expect(code).toContain('asset-root-uuid');
      expect(code).not.toContain('subasset-uuid-must-not-be-selected');
      expect(code).not.toContain('?uuid');
    }
    const headlessBuildDir = join(project, 'build-headless');
    await builder.buildProd({
      buildDir: headlessBuildDir,
      debug: true,
      sourceMaps: false,
      platform: 'nodejs',
      headless: true,
    });
    for (const outDir of [join(project, 'temp/oms/out-headless'), join(headlessBuildDir, 'oms')]) {
      const files = (await fs.readdir(outDir, { recursive: true, withFileTypes: true }))
        .filter((entry) => entry.isFile() && entry.name.endsWith('.js'));
      const code = (await Promise.all(files.map((entry) => fs.readFile(join(entry
        .parentPath, entry.name), 'utf8')))).join('\n');
      expect(code).toContain('asset-root-uuid');
      expect(code).not.toContain('subasset-uuid-must-not-be-selected');
      expect(code).not.toContain('?uuid');
    }
    expect(await fs.readdir(join(project, 'src'))).toEqual(['index.headless.ts', 'index.ts']);
  } finally {
    await builder.close();
  }
});

it('keeps root, child and nested importer selections distinct', async () => {
  /// @case
  /// One asset is imported without attributes and with several importer selectors, including
  /// a nested resource referenced by a plugin-generated module.
  /// @expect
  /// Dev and production builds preserve each selected resource's own UUID, and virtual module
  /// resolution forwards the selector without requiring an intermediate source file.
  const project = await createProject();
  const asset = join(project, 'assets/example.png');
  const values = [
    'root-uuid',
    'root-uuid',
    'texture-uuid',
    'frame-uuid',
    'custom-uuid',
    'frame-uuid',
  ];
  await fs.outputFile(asset, 'asset contents');
  await fs.outputJson(`${asset}.meta`, {
    uuid: 'root-uuid',
    importer: 'image',
    subMetas: {
      texture: {
        uuid: 'texture-uuid',
        importer: 'texture',
      },
      atlas: {
        uuid: 'atlas-uuid',
        importer: 'atlas',
        subMetas: {
          frame: {
            uuid: 'frame-uuid',
            importer: 'sprite-frame',
          },
        },
      },
      custom: {
        uuid: 'custom-uuid',
        importer: 'custom-view',
      },
    },
  });
  await fs.outputFile(join(project, 'src/index.ts'), [
    'import root from "../assets/example.png?uuid";',
    'import image from "../assets/example.png?uuid" with { importer: "image" };',
    'import texture from "../assets/example.png?uuid" with { importer: "texture" };',
    'import frame from "@image?uuid" with { importer: "sprite-frame" };',
    `import custom from ${JSON.stringify(asset.replaceAll('\\', '/') + '?uuid')}`
    + ' with { importer: "custom-view" };',
    'import virtual from "generated-frame";',
    'export const values = [root, image, texture, frame, custom, virtual];',
  ].join('\n'));
  await fs.outputFile(join(project, 'src/index.headless.ts'),
    'export { values } from "./index.js";');
  await fs.outputFile(join(project, 'oms.config.js'), [
    `const originalFile = ${JSON.stringify(join(project, 'src/view.custom'))};`,
    'export default {',
    'profiles: { headless: { include: [] } },',
    `resolve: { alias: { "@image": ${JSON.stringify(asset)} } },`,
    'plugins: [{ name: "test:importer-virtual", enforce: "pre",',
    'async resolveId(source, parent, options) {',
    'if (source === "generated-frame") return "\\0generated-frame";',
    'if (parent === "\\0generated-frame" && options.attributes.importer !== "sprite-frame")'
    + ' this.error("Missing importer attribute");',
    'if (parent === "\\0generated-frame") return this.resolve(source, originalFile, options);',
    '},',
    'load(id) { if (id === "\\0generated-frame") return '
    + JSON.stringify('export { default } from "../assets/example.png?uuid"'
      + ' with { importer: "sprite-frame" };') + '; }',
    '}] };',
  ].join('\n'));
  const builder = createBuilder(project);
  try {
    await builder.updateBuildOptions({ extensionBuildOptions: [] });
    expect(await builder.rebuild()).toMatchObject({
      default: { ok: true },
      headless: { ok: true },
    });
    const webBuildDir = join(project, 'build-web');
    await builder.buildProd({
      buildDir: webBuildDir,
      debug: true,
      sourceMaps: false,
      platform: 'web',
      headless: false,
    });
    for (const outDir of [join(project, 'temp/oms/out'), join(webBuildDir, 'oms')]) {
      const code = await fs.readFile(join(outDir, 'bundle-main.js'), 'utf8');
      for (const uuid of new Set(values)) {
        expect(code).toContain(uuid);
      }
      expect(code).not.toContain('atlas-uuid');
      expect(code).not.toContain('?uuid');
    }
    const buildDir = join(project, 'build-headless');
    await builder.buildProd({
      buildDir,
      debug: true,
      sourceMaps: false,
      platform: 'nodejs',
      headless: true,
    });
    for (const outDir of [join(project, 'temp/oms/out-headless'), join(buildDir, 'oms')]) {
      await fs.outputJson(join(outDir, 'package.json'), { type: 'module' });
      const namespace = await import(pathToFileURL(join(outDir, 'bundle-main.headless.js')).href);
      expect(namespace.values).toEqual(values);
    }
  } finally {
    await builder.close();
  }
});

it.each([
  [
    'missing',
    '{"uuid":"root","importer":"image"}',
    'sprite-frame',
    'found 0',
  ],
  [
    'siblings',
    '{"subMetas":{"a":{"uuid":"a","importer":"sprite-frame"},'
    + '"b":{"uuid":"b","importer":"sprite-frame"}}}',
    'sprite-frame',
    'found 2',
  ],
  [
    'root and nested',
    '{"uuid":"a","importer":"sprite-frame","subMetas":{"nested":{"subMetas":'
    + '{"b":{"uuid":"b","importer":"sprite-frame"}}}}}',
    'sprite-frame',
    'found 2',
  ],
  [
    'invalid UUID',
    '{"uuid":"root","subMetas":{"frame":{"importer":"sprite-frame","uuid":""}}}',
    'sprite-frame',
    'non-empty uuid',
  ],
  [
    'empty importer',
    '{"uuid":"root"}',
    '',
    'non-empty importer',
  ],
] as const)('rejects invalid importer selections (%s)', async (
  _scenario, metadata, importer, message,
) => {
  /// @case
  /// An importer selector is empty, absent from metadata, ambiguous, or matches an invalid UUID.
  /// @expect
  /// The build fails with a diagnostic instead of selecting the root or an arbitrary match.
  const project = await createProject();
  const asset = join(project, 'assets/example.png');
  await fs.outputFile(asset, 'asset contents');
  await fs.outputFile(`${asset}.meta`, metadata);
  await fs.outputFile(join(project, 'src/index.ts'),
    'export { default as uuid } from "../assets/example.png?uuid"'
    + ` with { importer: ${JSON.stringify(importer)} };`);
  const builder = createBuilder(project);
  try {
    await builder.updateBuildOptions({ extensionBuildOptions: [] });
    expect(await builder.rebuild()).toMatchObject({
      default: {
        ok: false,
        error: { message: expect.stringContaining(message) },
      },
    });
  } finally {
    await builder.close();
  }
});

it('recovers importer selections after missing and ambiguous metadata', async () => {
  /// @case
  /// A selector initially has no match; metadata adds a match, adds a duplicate, then restores
  /// a unique match with a different UUID while the importing source stays unchanged.
  /// @expect
  /// Metadata alone recovers failed builds and refreshes the selected UUID without stale cache.
  const project = await createProject();
  const asset = join(project, 'assets/example.png');
  await fs.outputFile(asset, 'asset contents');
  await fs.outputJson(`${asset}.meta`, { uuid: 'root-uuid', importer: 'image' });
  await fs.outputFile(join(project, 'src/index.ts'),
    'export { default as uuid } from "../assets/example.png?uuid"'
    + ' with { importer: "sprite-frame" };');
  const builder = createBuilder(project);
  try {
    await builder.updateBuildOptions({ extensionBuildOptions: [] });
    expect(await builder.rebuild()).toMatchObject({ default: { ok: false } });
    await delay(150);
    for (const uuid of ['first-frame', 'ambiguous', 'second-frame']) {
      const completion = nextPassiveBuild(builder);
      await fs.outputJson(`${asset}.meta`, {
        uuid: 'root-uuid',
        importer: 'image',
        subMetas: {
          frame: {
            uuid,
            importer: 'sprite-frame',
          },
          ...(uuid === 'ambiguous'
            ? {
              duplicate: {
                uuid: 'duplicate-frame',
                importer: 'sprite-frame',
              },
            }
            : {}),
        },
      });
      expect(await completion).toMatchObject({
        profileResults: { default: { ok: uuid !== 'ambiguous' } },
      });
      if (uuid !== 'ambiguous') {
        expect(await fs.readFile(join(project, 'temp/oms/out/bundle-main.js'), 'utf8'))
          .toContain(uuid);
      }
      await delay(150);
    }
  } finally {
    await builder.close();
  }
});

it.each([
  [
    'assets-extra/example.png',
    '{"uuid":"outside"}',
    'configured asset directories',
  ],
  [
    'assets/example.png',
    undefined,
    '.meta',
  ],
  [
    'assets/example.png',
    '{}',
    'uuid',
  ],
  [
    'assets/example.png',
    '{invalid',
    '.meta',
  ],
] as const)('rejects invalid ?uuid imports (%s, %s)', async (assetName, metadata, message) => {
  /// @case
  /// A UUID import references an asset outside the database root or missing/invalid metadata.
  /// @expect
  /// The public build fails with a diagnostic instead of exporting an undefined or fabricated UUID.
  const project = await createProject();
  const asset = join(project, assetName);
  await fs.outputFile(asset, 'asset');
  if (metadata !== undefined) {
    await fs.outputFile(`${asset}.meta`, metadata);
  }
  await fs.outputFile(join(project, 'src/index.ts'),
    `export { default as uuid } from ${JSON.stringify('../' + assetName + '?uuid')};`);
  const builder = createBuilder(project);
  try {
    await builder.updateBuildOptions({ extensionBuildOptions: [] });
    const result = await builder.rebuild();
    expect(result).toMatchObject({
      default: {
        ok: false,
        error: {
          message: expect.stringContaining(message),
        },
      },
    });
    if (metadata === undefined || metadata === '{invalid') {
      expect(result).toMatchObject({
        default: {
          error: {
            message: expect.stringContaining(`Cannot read or parse asset metadata ${asset}.meta`),
            stack: expect.stringContaining('Caused by:'),
          },
        },
      });
      expect(result.default?.ok === false && result.default.error.stack)
        .toContain(metadata === undefined ? 'ENOENT' : 'SyntaxError');
    }
  } finally {
    await builder.close();
  }
});

it(('recovers ?uuid imports when metadata or the asset is created and '
  + 'removes unused metadata watches'), async () => {
  /// @case
  /// A UUID import starts with missing metadata, then metadata and asset changes occur before the
  /// import is removed.
  /// @expect
  /// Native Rollup failure dependencies recover automatically, updates refresh the UUID, and
  /// obsolete metadata stops triggering builds.
  const project = await createProject();
  const asset = join(project, 'assets/example.png');
  const metadata = `${asset}.meta`;
  const source = join(project, 'src/index.ts');
  await fs.outputFile(asset, 'asset');
  await fs.outputFile(source, 'export { default as uuid } from "../assets/example.png?uuid";');
  const builder = createBuilder(project);
  try {
    await builder.updateBuildOptions({ extensionBuildOptions: [] });
    expect(await builder.rebuild()).toMatchObject({ default: { ok: false } });
    // Existing watcher.add() subscriptions activate asynchronously, as before plugin support.
    await delay(150);
    for (const value of [
      'first-uuid',
      'second-uuid',
      undefined,
      'recovered-uuid',
    ]) {
      const completion = nextPassiveBuild(builder);
      if (value === undefined) {
        await fs.remove(metadata);
      } else {
        await fs.outputJson(metadata, { uuid: value });
      }
      expect(await completion).toMatchObject({ profileResults: { default: { ok:
        value !== undefined } } });
      if (value !== undefined) {
        expect(await fs.readFile(join(project, 'temp/oms/out/bundle-main.js'), 'utf8'))
          .toContain(value);
      }
      await delay(150);
    }
    const deletion = nextPassiveBuild(builder);
    await fs.remove(asset);
    expect(await deletion).toMatchObject({ profileResults: { default: { ok: false } } });
    await delay(150);
    const recovery = nextPassiveBuild(builder);
    await fs.outputFile(asset, 'recreated asset');
    expect(await recovery).toMatchObject({ profileResults: { default: { ok: true } } });
    const removal = nextPassiveBuild(builder);
    await fs.outputFile(source, 'export const marker = "no-asset-dependency";');
    expect(await removal).toMatchObject({ profileResults: { default: { ok: true } } });
    await delay(150);
    const builds: PassiveBuildEndInfo[] = [];
    const record = (info: PassiveBuildEndInfo) => builds.push(info);
    builder.on('passive-build-end', record);
    await fs.outputJson(metadata, { uuid: 'unused-uuid' });
    await delay(500);
    builder.off('passive-build-end', record);
    expect(builds).toEqual([]);
  } finally {
    await builder.close();
  }
}, 15000);

it(('retains newly discovered metadata dependencies after an output write '
  + 'failure'), async () => {
  /// @case
  /// A source adds a UUID import while a directory blocks its output file, then only metadata
  /// changes after the obstruction is removed.
  /// @expect
  /// The write failure reports the output path and retains the new dependency so metadata alone
  /// triggers a successful rebuild.
  const project = await createProject();
  const asset = join(project, 'assets/example.png');
  const metadata = `${asset}.meta`;
  const source = join(project, 'src/index.ts');
  const output = join(project, 'temp/oms/out/bundle-main.js');
  const importSource = 'export { default as uuid } from "../assets/example.png?uuid";';
  await fs.outputFile(asset, 'asset');
  await fs.outputJson(metadata, { uuid: 'before-write-failure' });
  await fs.outputFile(source, 'export const marker = "without-asset";');
  const builder = createBuilder(project);
  try {
    await builder.updateBuildOptions({ extensionBuildOptions: [] });
    expect(await builder.rebuild()).toMatchObject({ default: { ok: true } });
    await fs.remove(output);
    await fs.ensureDir(output);
    const failure = nextPassiveBuild(builder);
    await fs.outputFile(source, importSource);
    expect(await failure).toMatchObject({
      profileResults: {
        default: {
          ok: false,
          error: { message: expect.stringContaining('bundle-main.js') },
        },
      },
    });
    await delay(150);
    await fs.remove(output);
    const recovery = nextPassiveBuild(builder);
    await fs.outputJson(metadata, { uuid: 'after-write-failure' });
    expect(await recovery).toMatchObject({ profileResults: { default: { ok: true } } });
    expect(await fs.readFile(output, 'utf8')).toContain('after-write-failure');
    expect(await fs.readFile(source, 'utf8')).toBe(importSource);
  } finally {
    await builder.close();
  }
});

it('retains a shared ?uuid metadata watch until both profiles stop importing it', async () => {
  /// @case
  /// Both profiles import one asset, then default drops the import before headless does.
  /// @expect
  /// Metadata still rebuilds headless after default drops it and stops triggering builds once both
  /// profiles drop it.
  const project = await createProject();
  const asset = join(project, 'assets/shared.png');
  const metadata = `${asset}.meta`;
  const source = join(project, 'src/index.ts');
  const headlessSource = join(project, 'src/index.headless.ts');
  const importSource = 'export { default as uuid } from "../assets/shared.png?uuid";';
  await fs.outputFile(asset, 'asset');
  await fs.outputJson(metadata, { uuid: 'shared-first' });
  await fs.outputFile(source, importSource);
  await fs.outputFile(headlessSource, importSource);
  await fs.outputFile(join(project, 'oms.config.js'),
    'export default { profiles: { headless: { include: [] } } };');
  const builder = createBuilder(project);
  try {
    await builder.updateBuildOptions({ extensionBuildOptions: [] });
    expect(await builder.rebuild()).toMatchObject({ default: { ok: true },
      headless: { ok: true } });
    await delay(150);
    const defaultRemoval = nextPassiveBuild(builder);
    await fs.outputFile(source, 'export const marker = "default-without-asset";');
    expect(await defaultRemoval).toMatchObject({ profileResults: { default: { ok: true },
      headless: { ok: true } } });
    const changed = nextPassiveBuild(builder);
    await fs.outputJson(metadata, { uuid: 'shared-second' });
    expect(await changed).toMatchObject({ profileResults: { headless: { ok: true } } });
    const outDir = join(project, 'temp/oms/out-headless');
    const files = (await fs.readdir(outDir, { recursive: true, withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.js'));
    const output = (await Promise.all(files.map((entry) => fs.readFile(join(entry
      .parentPath, entry.name), 'utf8')))).join('\n');
    expect(output).toContain('shared-second');
    const headlessRemoval = nextPassiveBuild(builder);
    await fs.outputFile(headlessSource, 'export const marker = "headless-without-asset";');
    expect(await headlessRemoval).toMatchObject({ profileResults: { default: { ok:
      true },
    headless: { ok: true } } });
    await delay(150);
    const builds: PassiveBuildEndInfo[] = [];
    const record = (info: PassiveBuildEndInfo) => builds.push(info);
    builder.on('passive-build-end', record);
    await fs.outputJson(metadata, { uuid: 'shared-unused' });
    await delay(500);
    builder.off('passive-build-end', record);
    expect(builds).toEqual([]);
  } finally {
    await builder.close();
  }
}, 10000);

it.each([
  'config',
  'configResolved',
  'transform',
  'watchChange',
  'buildEnd',
  'closeBundle',
])('rejects the unused %s hook in a JavaScript project config', async (hook) => {
  /// @case
  /// A JavaScript configuration registers a hook outside the supported source-loader subset.
  /// @expect
  /// The public builder reports the unsupported option rather than silently accepting or running
  /// it.
  const project = await createProject();
  await fs.outputFile(join(project, 'src/index.ts'), 'export const value = 1;');
  await fs.outputFile(join(project, 'oms.config.js'),
    `export default { plugins: [{ name: "test:unsupported", ${hook}() {} }] };`);
  const builder = createBuilder(project);
  try {
    await builder.rebuild();
    await expect(builder.buildProd({
      buildDir: join(project, 'build'),
      debug: true,
      sourceMaps: false,
      platform: 'web',
      headless: false,
    })).rejects.toThrow(`unsupported plugin option ${hook}`);
  } finally {
    await builder.close();
  }
});

it.each([
  'buildStart',
  'resolveId',
  'load',
])('rejects object-form %s hooks in a JavaScript config', async (hook) => {
  /// @case
  /// A configuration uses an object hook instead of the supported function form.
  /// @expect
  /// Configuration loading fails with the hook name and required form.
  const project = await createProject();
  await fs.outputFile(join(project, 'oms.config.js'),
    `export default { plugins: [{ name: "test:object", ${hook}: { handler() {} } }] };`);
  const builder = createBuilder(project);
  try {
    await builder.rebuild();
    await expect(builder.buildProd({
      buildDir: join(project, 'build'),
      debug: true,
      sourceMaps: false,
      platform: 'web',
      headless: false,
    })).rejects.toThrow(`${hook} must be a function`);
  } finally {
    await builder.close();
  }
});

it('rejects post plugins in a JavaScript config', async () => {
  /// @case
  /// A configuration requests the removed post group.
  /// @expect
  /// The public builder reports the invalid enforce value.
  const project = await createProject();
  await fs.outputFile(join(project, 'oms.config.js'),
    'export default { plugins: [{ name: "test:post", enforce: "post" }] };');
  const builder = createBuilder(project);
  try {
    await builder.rebuild();
    await expect(builder.buildProd({
      buildDir: join(project, 'build'),
      debug: true,
      sourceMaps: false,
      platform: 'web',
      headless: false,
    })).rejects.toThrow('invalid enforce value');
  } finally {
    await builder.close();
  }
});

it(('loads derived virtual modules through development, production and real '
  + 'Vite without generating inputs'), async () => {
  /// @case
  /// A source loader produces a virtual child importing a relative helper and an external
  /// dependency.
  /// @expect
  /// Only the public context is available, resolution skips the caller, relative TypeScript imports
  /// compile, and the same plugin works in OMS and Vite.
  const project = await createProject();
  const api = join(project, 'node_modules/@oms/plugin');
  await fs.copy(resolve(import.meta.dirname, '../../plugin/package.json'), join(api,
    'package.json'));
  await fs.copy(resolve(import.meta.dirname, '../../plugin/lib'), join(api, 'lib'));
  const log = join(project, 'builds.jsonl');
  await fs.outputFile(join(project, 'src/index.ts'), 'export { value } from "./view.custom";');
  await fs.outputFile(join(project, 'src/view.custom'), '<source-language />');
  await fs.outputFile(join(project, 'src/relative.ts'), 'export const relative: number = 40;');
  await fs.outputFile(join(project, 'oms.config.js'), [
    'import fs from "node:fs";',
    'import { defineConfig } from "@oms/plugin";',
    `const record = value => fs.appendFileSync(${JSON.stringify(
      log)}, JSON.stringify(value) + "\\n");`,
    'const compiler = {',
    'name: "test:compiler", enforce: "pre",',
    'buildStart() {',
    ('this.cache.set("modules", {}); record({ event: "start", context: '
      + 'Object.keys(this).sort(), cache: Object.keys(this.cache).sort() });'),
    '},',
    'async resolveId(source, importer, options) {',
    'if (source.startsWith("\\0derived:")) return source;',
    ('if (importer?.startsWith("\\0derived:")) return this.resolve(source, '
      + 'importer.slice("\\0derived:".length), options);'),
    ('if (source === "./view.custom") { record({ event: "delegate" }); '
      + 'return this.resolve(source, importer, options); }'),
    '},',
    'load(id) {',
    ('if (id.startsWith("\\0derived:")) { '
      + 'this.addWatchFile(id.slice("\\0derived:".length)); return { code: '
      + '"import { relative } from \\"./relative.ts\\"; import { ext } from '
      + '\\"external-api\\"; globalThis.__pluginExternal = ext; export const '
      + 'value = relative + FEATURE; globalThis.__pluginValue = value;", map: '
      + 'null }; }'),
    'if (!id.endsWith(".custom")) return;',
    'this.addWatchFile(id);',
    ('return { code: `export { value } from ${JSON.stringify("\\0derived:" + '
      + 'id)};`, map: null };'),
    '},',
    '};',
    'const external = {',
    ('name: "test:external", resolveId(source) { if (source === '
      + '"external-api") return { id: source, external: true }; },'),
    '};',
    ('export default defineConfig({ plugins: [compiler, external], define: { '
      + 'FEATURE: 2 } });'),
  ].join('\n'));
  const inputs = await fs.readdir(join(project, 'src'));
  const builder = createBuilder(project);
  try {
    await builder.updateBuildOptions({ extensionBuildOptions: [] });
    expect(await builder.rebuild()).toMatchObject({ default: { ok: true } });
    const buildDir = join(project, 'build');
    await builder.buildProd({
      buildDir,
      debug: true,
      sourceMaps: false,
      platform: 'web',
      headless: false,
    });
    for (const dir of [join(project, 'temp/oms/out'), join(buildDir, 'oms')]) {
      const output = await fs.readFile(join(dir, 'bundle-main.js'), 'utf8');
      expect(output).toContain('external-api');
      expect(output).toContain('40');
      expect(output).toContain('2');
      expect(output).not.toContain('<source-language');
      expect(output).not.toContain(': number');
    }
  } finally {
    await builder.close();
  }
  expect(await fs.readdir(join(project, 'src'))).toEqual(inputs);
  const events = (await fs.readFile(log, 'utf8')).trim().split('\n').map((line) => JSON
    .parse(line));
  expect(events.filter((event) => event.event === 'start')).toHaveLength(2);
  for (const event of events.filter((event) => event.event === 'start')) {
    expect(event.context).toEqual([
      'addWatchFile',
      'cache',
      'error',
      'resolve',
    ]);
    expect(event.cache).toEqual(['get', 'set']);
  }
  expect(events.filter((event) => event.event === 'delegate')).toHaveLength(2);
  const config = (await import(pathToFileURL(join(project, 'oms.config.js')).href)).default;
  const viteOutput = await buildVite({
    ...config,
    root: project,
    configFile: false,
    logLevel: 'silent',
    build: {
      write: false,
      minify: false,
      lib: {
        entry: join(project, 'src/index.ts'),
        formats: ['es'],
      },
    },
  });
  const outputs = Array.isArray(viteOutput) ? viteOutput : [viteOutput];
  expect(outputs.flatMap((output) => 'output' in output ? output.output : []).filter((
    output) => output.type === 'chunk').map((chunk) => chunk.code).join('\n')).toContain(
    'external-api');
});

it(('recompiles unchanged source on dependency creation in an existing '
  + 'directory, update, deletion and recovery'), async () => {
  /// @case
  /// A loader requires a missing metadata file in an existing directory, then it is created,
  /// changed, deleted and recreated without changing the source.
  /// @expect
  /// Each event rebuilds; missing dependencies produce a positioned error and are retained for
  /// automatic recovery.
  const project = await createProject();
  const dependency = join(project, 'metadata/value.meta');
  await fs.ensureDir(dirname(dependency));
  await fs.outputFile(join(project, 'src/view.custom'), 'unchanged');
  await fs.outputFile(join(project, 'src/index.ts'), 'export { marker } from "./view.custom";');
  await fs.outputFile(join(project, 'oms.config.js'), [
    'import fs from "node:fs";',
    `const dependency = ${JSON.stringify(dependency)};`,
    'export default { plugins: [{',
    'name: "test:watch", enforce: "pre",',
    'load(id) {',
    'if (!id.endsWith(".custom")) return;',
    'this.addWatchFile(id); this.addWatchFile(dependency);',
    ('if (!fs.existsSync(dependency)) this.error({ message: "Missing '
      + 'compiler metadata", id, loc: { line: 1, column: 0 } });'),
    ('return { code: `export const marker = '
      + '${JSON.stringify(fs.readFileSync(id, "utf8") + '
      + 'fs.readFileSync(dependency, "utf8"))};`, map: null };'),
    '}',
    '}] };',
  ].join('\n'));
  const builder = createBuilder(project);
  try {
    await builder.updateBuildOptions({ extensionBuildOptions: [] });
    const initial = await builder.rebuild();
    expect(initial).toMatchObject({
      default: {
        ok: false,
        error: {
          message: expect.stringContaining('Missing compiler metadata'),
        },
      },
    });
    // watcher.add() retains the existing asynchronous subscription window.
    await delay(150);
    for (const value of [
      'one',
      'two',
      undefined,
      'recovered',
    ]) {
      const completion = new Promise<PassiveBuildEndInfo>((done, reject) => {
        const timeout = setTimeout(() => {
          builder.off('passive-build-end', listener);
          reject(new Error('Missing dependency rebuild'));
        }, 5000);
        const listener = (info: PassiveBuildEndInfo) => {
          clearTimeout(timeout);
          done(info);
        };
        builder.once('passive-build-end', listener);
      });
      if (value === undefined) {
        await fs.remove(dependency);
      } else {
        await fs.outputFile(dependency, value);
      }
      expect(await completion).toMatchObject({ profileResults: { default: { ok:
        value !== undefined } } });
      if (value !== undefined) {
        expect(await fs.readFile(join(project, 'temp/oms/out/bundle-main.js'), 'utf8'))
          .toContain(`unchanged${value}`);
      }
      await delay(150);
    }
  } finally {
    await builder.close();
  }
}, 15000);

it(('preserves native resolution delegation and separates profile caches '
  + 'across configuration reloads'), async () => {
  /// @case
  /// A source-loader delegates a request with custom options and two profiles rebuild before
  /// configuration changes.
  /// @expect
  /// Native skipSelf allows a nested request, unresolved imports return null, false marks
  /// externals, and each profile owns its cache.
  const project = await createProject();
  const log = join(project, 'cache.jsonl');
  const configFile = join(project, 'oms.config.js');
  await fs.outputFile(join(project, 'src/index.ts'), 'export { marker } from "entry-virtual";');
  await fs.outputFile(join(project, 'src/index.headless.ts'),
    'export { marker } from "entry-virtual";');
  const config = [
    'import fs from "node:fs";',
    `const record = value => fs.appendFileSync(${JSON.stringify(
      log)}, JSON.stringify(value) + "\\n");`,
    ('export default { profiles: { headless: {} }, define: { CONFIG_MARKER: '
      + '42 }, plugins: [{'),
    'name: "test:native", enforce: "pre",',
    'async buildStart() {',
    ('if (await this.resolve("missing-native-module") !== null) '
      + 'this.error("Expected null");'),
    ('const count = (this.cache.get("count") ?? 0) + 1; '
      + 'this.cache.set("count", count); record(count);'),
    '},',
    'async resolveId(source, importer) {',
    ('if (source === "entry-virtual") return this.resolve(source, importer, '
      + '{ custom: { consumer: { marker: 42 } } });'),
    ('if (source === "nested-virtual") return { id: "\\0native", '
      + 'moduleSideEffects: false, meta: { marker: 42 } };'),
    'if (source === "external-native") return false;',
    '},',
    ('load(id) { if (id === "\\0native") return "import { unused } from '
      + '\\"external-native\\"; globalThis.__native = unused; export const marker '
      + '= CONFIG_MARKER;"; },'),
    '}, {',
    'name: "test:delegate", async resolveId(source, importer, options) {',
    'if (source !== "entry-virtual") return;',
    ('if (options.custom?.consumer?.marker !== 42) this.error("Custom '
      + 'options lost");'),
    'return this.resolve("nested-virtual", importer);',
    '} } ] };',
  ].join('\n');
  await fs.outputFile(configFile, config);
  const events = async () => (await fs.readFile(log, 'utf8')).trim().split('\n').map((
    line) => JSON.parse(line));
  const builder = createBuilder(project);
  try {
    await builder.updateBuildOptions({ extensionBuildOptions: [] });
    expect(await builder.rebuild()).toMatchObject({ default: { ok: true },
      headless: { ok: true } });
    expect(await builder.rebuild()).toMatchObject({ default: { ok: true },
      headless: { ok: true } });
    expect(await events()).toEqual([
      1,
      1,
      2,
      2,
    ]);
    const completion = new Promise<PassiveBuildEndInfo>((done) => builder.once(
      'passive-build-end', done));
    await fs.outputFile(configFile, config.replace('CONFIG_MARKER: 42', 'CONFIG_MARKER: 43'));
    expect(await completion).toMatchObject({ profileResults: { default: { ok: true },
      headless: { ok: true } } });
    expect(await events()).toEqual([
      1,
      1,
      2,
      2,
      1,
      1,
    ]);
    const output = await fs.readFile(join(project, 'temp/oms/out/bundle-main.js'), 'utf8');
    expect(output).toContain('43');
    expect(output).toContain('external-native');
  } finally {
    await builder.close();
  }
});

it(('watches a replacement compiler dependency and releases the previous '
  + 'dependency'), async () => {
  /// @case
  /// A source switches between two existing metadata files in the same directory.
  /// @expect
  /// The new dependency recompiles the unchanged source; the obsolete dependency no longer triggers
  /// builds.
  const project = await createProject();
  const source = join(project, 'src/view.custom');
  await fs.outputFile(source, 'first');
  await fs.outputFile(join(project, 'src/index.ts'), 'export { marker } from "./view.custom";');
  await fs.outputFile(join(project, 'metadata/first.meta'), 'before');
  await fs.outputFile(join(project, 'metadata/second.meta'), 'before');
  await fs.outputFile(join(project, 'oms.config.js'), [
    'import fs from "node:fs";',
    'import { join } from "node:path";',
    `const root = ${JSON.stringify(project)};`,
    'export default { plugins: [{ name: "test:switch", enforce: "pre",',
    'load(id) {',
    'if (!id.endsWith(".custom")) return;',
    ('this.addWatchFile(id); const dependency = join(root, "metadata", '
      + 'fs.readFileSync(id, "utf8") + ".meta");'),
    'this.addWatchFile(dependency);',
    ('return { code: `export const marker = '
      + '${JSON.stringify(fs.readFileSync(dependency, "utf8"))};`, map: null };'),
    '} }] };',
  ].join('\n'));
  const builder = createBuilder(project);
  const nextBuild = () => new Promise<PassiveBuildEndInfo>((done) => builder.once(
    'passive-build-end', done));
  try {
    await builder.updateBuildOptions({ extensionBuildOptions: [] });
    expect(await builder.rebuild()).toMatchObject({ default: { ok: true } });
    await delay(150);
    const switchBuild = nextBuild();
    await fs.outputFile(source, 'second');
    expect(await switchBuild).toMatchObject({ profileResults: { default: { ok: true } } });
    await delay(150);
    const changedBuild = nextBuild();
    await fs.outputFile(join(project, 'metadata/second.meta'), 'after-switch');
    expect(await changedBuild).toMatchObject({ profileResults: { default: { ok: true } } });
    expect(await fs.readFile(join(project, 'temp/oms/out/bundle-main.js'), 'utf8'))
      .toContain('after-switch');
    const builds: PassiveBuildEndInfo[] = [];
    const record = (info: PassiveBuildEndInfo) => builds.push(info);
    builder.on('passive-build-end', record);
    await fs.outputFile(join(project, 'metadata/first.meta'), 'obsolete');
    await delay(500);
    builder.off('passive-build-end', record);
    expect(builds).toEqual([]);
  } finally {
    await builder.close();
  }
});

it.each(['custom extension', 'virtual module'] as const)(
  'lowers plugin-generated JavaScript to the configured target (%s)', async (kind) => {
  /// @case
  /// A loader returns JavaScript using optional chaining, nullish coalescing and a CommonJS
  /// dependency under a custom or virtual module ID for a node10 profile.
  /// @expect
  /// Development and production outputs omit unsupported syntax and preserve nullish values and
  /// zero at runtime.
    const project = await createProject();
    const source = kind === 'custom extension' ? './view.custom' : 'generated';
    const id = kind === 'custom extension' ? join(project, 'src/view.custom') : '\0test:generated';
    if (kind === 'custom extension') {
      await fs.outputFile(id, '<source-language />');
    }
    await fs.outputFile(join(project, 'src/index.headless.ts'),
      `export { runLoadedFeatures } from ${JSON.stringify(source)};`);
    const dependency = join(project, 'src/fallback.cjs');
    await fs.outputFile(dependency, 'module.exports = { amount: 42 };');
    const code = [
      `import fallback from ${JSON.stringify(dependency.replaceAll('\\', '/'))};`,
      ('export function runLoadedFeatures(value) { return value?.amount ?? '
        + 'fallback.amount; }'),
    ].join('\n');
    await fs.outputFile(join(project, 'oms.config.js'), [
      'export default {',
      'profiles: { headless: { include: [], build: { target: "node10" } } },',
      'plugins: [{ name: "test:target",',
      `resolveId(source) { if (source === ${JSON.stringify(source)}) return ${JSON
        .stringify(id)}; },`,
      `load(id) { if (id === ${JSON.stringify(id)}) return ${JSON.stringify(code)}; }`,
      '}] };',
    ].join('\n'));
    const builder = createBuilder(project);
    try {
      await builder.updateBuildOptions({ extensionBuildOptions: [] });
      expect(await builder.rebuild()).toMatchObject({ headless: { ok: true } });
      const buildDir = join(project, 'build');
      await builder.buildProd({
        buildDir,
        debug: true,
        sourceMaps: false,
        platform: 'nodejs',
        headless: true,
      });
      for (const outDir of [join(project, 'temp/oms/out-headless'), join(buildDir, 'oms')]) {
        const files = (await fs.readdir(outDir, { recursive: true, withFileTypes: true }))
          .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
          .map((entry) => join(entry.parentPath, entry.name));
        const scripts = await Promise.all(files.map((file) => fs.readFile(file, 'utf8')));
        const moduleIndex = scripts.findIndex((script) => script.includes(
          'function runLoadedFeatures('));
        expect(moduleIndex).toBeGreaterThanOrEqual(0);
        const output = scripts.join('\n');
        expect(output).not.toContain('?.');
        expect(output).not.toContain('??');
        await fs.outputJson(join(outDir, 'package.json'), { type: 'module' });
        const namespace = await import(pathToFileURL(files[moduleIndex]).href);
        expect(namespace.runLoadedFeatures(undefined)).toBe(42);
        expect(namespace.runLoadedFeatures({})).toBe(42);
        expect(namespace.runLoadedFeatures({ amount: 0 })).toBe(0);
      }
    } finally {
      await builder.close();
    }
  });

it(('executes class fields, private methods and brand checks for a modern '
  + 'headless target'), async () => {
  /// @case
  /// A node22 profile imports standard JavaScript combining public fields, private fields, methods
  /// and accessors.
  /// @expect
  /// Development and production builds succeed, preserving initialization, method calls, accessors
  /// and private brand checks.
  const project = await createProject();
  await fs.outputFile(join(project, 'src', 'runtime.js'), [
    'class ClassFeatures {',
    '  #value = 40;',
    '  field = this.#increment();',
    '  #increment() { return this.#value + 2; }',
    '  get #current() { return this.#value; }',
    '  set #current(value) { this.#value = value; }',
    '  read() { this.#current = this.field; return this.#current; }',
    ('  static has(candidate) { return #value in candidate && #increment in '
      + 'candidate; }'),
    '}',
    'export function runClassFeatures() {',
    '  const instance = new ClassFeatures();',
    ('  return [instance.field, instance.read(), '
      + 'ClassFeatures.has(instance), ClassFeatures.has({})];'),
    '}',
  ].join('\n'));
  await fs.outputFile(join(project, 'src', 'index.ts'),
    'export { runClassFeatures } from "./runtime.js";');
  await fs.outputFile(join(project, 'src', 'index.headless.ts'),
    'export { runClassFeatures } from "./runtime.js";');
  await fs.outputFile(join(project, 'oms.config.js'), (
    'export default { profiles: { headless: { include: [], build: { target: '
    + '"node22" } } } };'));
  const builder = createBuilder(project);
  try {
    await builder.updateBuildOptions({ extensionBuildOptions: [] });
    expect(await builder.rebuild()).toMatchObject({ default: { ok: true },
      headless: { ok: true } });
    const buildDir = join(project, 'build');
    await builder.buildProd({
      buildDir,
      debug: true,
      sourceMaps: false,
      platform: 'web',
      headless: true,
    });
    for (const outDir of [join(project, 'temp', 'oms', 'out-headless'), join(buildDir, 'oms')]) {
      const files = (await fs.readdir(outDir, { recursive: true, withFileTypes: true }))
        .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
        .map((entry) => join(entry.parentPath, entry.name));
      const scripts = await Promise.all(files.map((file) => fs.readFile(file, 'utf8')));
      const moduleIndex = scripts.findIndex((code) => code.includes('function runClassFeatures('));
      expect(moduleIndex).toBeGreaterThanOrEqual(0);
      await fs.outputJson(join(outDir, 'package.json'), { type: 'module' });
      const namespace = await import(pathToFileURL(files[moduleIndex]).href);
      expect(namespace.runClassFeatures()).toEqual([
        42,
        42,
        true,
        false,
      ]);
    }
  } finally {
    await builder.close();
  }
});
