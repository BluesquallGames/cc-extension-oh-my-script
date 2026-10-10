import { afterEach, expect, it, vi } from 'vitest';
import { originalPositionFor, TraceMap } from '@jridgewell/trace-mapping';
import fs from 'fs-extra';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import * as ts from 'typescript';
import { OmsBuilder } from '../src/oms-builder.js';
import { OmsProjectConfigWatcher } from '../src/config-watcher.js';
import { ServerContext } from '../src/server-context.js';
import { type BuildOptions, type RebuildOptions } from '../src/protocol.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => fs.remove(dir)));
  tempDirs.length = 0;
});

it('observes every profile rejection when a full build closes', async () => {
  /// @case
  /// 1. A full-profile build is waiting for its build-start notification.
  /// 2. The builder closes and rejects both profile lanes before the revision can continue.
  /// @expect
  /// The full build rejects once, every lane rejection is observed, and close finishes after the revision exits.
  const project = await makeTempDir();
  await fs.outputFile(join(project, 'oms.config.mjs'), 'export default { profiles: { headless: {} } };');
  await fs.outputFile(join(project, 'src', 'index.ts'), 'export const marker = "close-all-profiles";');
  const buildStarted = deferred<void>();
  const releaseBuild = deferred<void>();
  const ctx = new ServerContext({
    invoke: async (method: string) => {
      if (method === 'build-start') {
        buildStarted.resolve();
        await releaseBuild.promise;
      }
    },
  } as any);
  const builder = new OmsBuilder(ctx, { project });
  await builder.updateBuildOptions({ extensionBuildOptions: [] });

  const build = builder.rebuild();
  await buildStarted.promise;
  const close = builder.close();

  await expect(build).rejects.toThrow('OMS watcher closed');
  releaseBuild.resolve();
  await close;
});

it('recovers when the first watcher startup fails', async () => {
  /// @case
  /// 1. A file blocks creation of the default output directory while the builder starts its first watcher.
  /// 2. The path is repaired and the same builder receives another default-profile request.
  /// @expect
  /// Failed startup state is released and the second request starts a fresh watcher successfully.
  const project = await makeTempDir();
  await fs.outputFile(join(project, 'src', 'index.ts'), 'export const marker = "startup-recovery";');
  const blockedOutputPath = join(project, 'temp', 'oms', 'out');
  await fs.outputFile(blockedOutputPath, 'blocks the output directory');
  const ctx = new ServerContext({
    invoke: async () => undefined,
  } as any);
  const builder = new OmsBuilder(ctx, { project });
  await builder.updateBuildOptions({ extensionBuildOptions: [] });

  try {
    await expect(builder.rebuild({ profiles: ['default'] })).rejects.toThrow();
    await fs.remove(blockedOutputPath);
    await expect(builder.rebuild({ profiles: ['default'] })).resolves.toMatchObject({
      default: { ok: true },
    });
  } finally {
    await builder.close();
  }
});

it('serializes consecutive clean rebuilds through profile completion', async () => {
  /// @case
  /// 1. A clean rebuild is paused after its revision starts.
  /// 2. A second clean rebuild is requested before the first profile batch finishes.
  /// @expect
  /// The second request does not replace the first watcher; the first build finishes before the next clean build starts.
  const project = await makeTempDir();
  await fs.outputFile(join(project, 'oms.config.mjs'), 'export default { profiles: { headless: {} } };');
  await fs.outputFile(join(project, 'src', 'index.ts'), 'export const marker = "serialized-clean-rebuild";');
  const firstBuildStarted = deferred<void>();
  const releaseFirstBuild = deferred<void>();
  let buildStartCount = 0;
  const ctx = new ServerContext({
    invoke: async (method: string) => {
      if (method === 'build-start' && ++buildStartCount === 1) {
        firstBuildStarted.resolve();
        await releaseFirstBuild.promise;
      }
    },
  } as any);
  const builder = new OmsBuilder(ctx, { project });
  await builder.updateBuildOptions({ extensionBuildOptions: [] });

  try {
    const firstBuild = builder.cleanRebuild();
    await firstBuildStarted.promise;
    const secondBuild = builder.cleanRebuild();
    await Promise.resolve();
    expect(buildStartCount).toBe(1);

    releaseFirstBuild.resolve();
    await expect(firstBuild).resolves.toMatchObject({
      default: { ok: true },
      headless: { ok: true },
    });
    await expect(secondBuild).resolves.toMatchObject({
      default: { ok: true },
      headless: { ok: true },
    });
    expect(buildStartCount).toBe(2);
  } finally {
    releaseFirstBuild.resolve();
    await builder.close();
  }
});

it('shares clean watcher startup with a concurrent profile rebuild', async () => {
  /// @case
  /// 1. A clean rebuild starts a fresh watcher and pauses in its initial revision.
  /// 2. A default-profile rebuild arrives before the clean rebuild has finished every profile.
  /// @expect
  /// The profile caller joins the same watcher startup, both calls succeed, and no second startup tears the watcher down.
  const project = await makeTempDir();
  await fs.outputFile(join(project, 'oms.config.mjs'), 'export default { profiles: { headless: {} } };');
  await fs.outputFile(join(project, 'src', 'index.ts'), 'export const marker = "shared-clean-startup";');
  let buildStartCount = 0;
  const ctx = new ServerContext({
    invoke: async (method: string) => {
      if (method === 'build-start') {
        buildStartCount++;
      }
    },
  } as any);
  const builder = new OmsBuilder(ctx, { project });
  await builder.updateBuildOptions({ extensionBuildOptions: [] });

  try {
    const cleanBuild = builder.cleanRebuild();
    const defaultBuild = builder.rebuild({ profiles: ['default'] });

    await expect(defaultBuild).resolves.toMatchObject({
      default: { ok: true },
    });
    await expect(cleanBuild).resolves.toMatchObject({
      default: { ok: true },
      headless: { ok: true },
    });
    expect(buildStartCount).toBe(1);

    await expect(builder.rebuild({ profiles: ['default'] })).resolves.toMatchObject({
      default: { ok: true },
    });
  } finally {
    await builder.close();
  }
});

it('attaches profile rebuilds to the latest pending clean startup', async () => {
  /// @case
  /// 1. A clean rebuild is active while a second clean rebuild waits behind it.
  /// 2. A default-profile rebuild is requested before the first clean rebuild finishes.
  /// @expect
  /// The profile caller waits for the second clean watcher instead of settling from the watcher about to be replaced.
  const project = await makeTempDir();
  await fs.outputFile(join(project, 'oms.config.mjs'), 'export default { profiles: { headless: {} } };');
  await fs.outputFile(join(project, 'src', 'index.ts'), 'export const marker = "latest-clean-startup";');
  const firstBuildStarted = deferred<void>();
  const secondBuildStarted = deferred<void>();
  const releaseFirstBuild = deferred<void>();
  const releaseSecondBuild = deferred<void>();
  let buildStartCount = 0;
  const ctx = new ServerContext({
    invoke: async (method: string) => {
      if (method !== 'build-start') {
        return;
      }
      buildStartCount++;
      if (buildStartCount === 1) {
        firstBuildStarted.resolve();
        await releaseFirstBuild.promise;
      } else if (buildStartCount === 2) {
        secondBuildStarted.resolve();
        await releaseSecondBuild.promise;
      }
    },
  } as any);
  const builder = new OmsBuilder(ctx, { project });
  await builder.updateBuildOptions({ extensionBuildOptions: [] });

  try {
    const firstCleanBuild = builder.cleanRebuild();
    await firstBuildStarted.promise;
    const secondCleanBuild = builder.cleanRebuild();
    const defaultBuild = builder.rebuild({ profiles: ['default'] });

    releaseFirstBuild.resolve();
    const firstSettlement = await Promise.race([
      defaultBuild.then(() => 'default-build'),
      secondBuildStarted.promise.then(() => 'second-build-started'),
    ]);
    expect(firstSettlement).toBe('second-build-started');

    releaseSecondBuild.resolve();
    await expect(firstCleanBuild).resolves.toMatchObject({
      default: { ok: true },
      headless: { ok: true },
    });
    await expect(secondCleanBuild).resolves.toMatchObject({
      default: { ok: true },
      headless: { ok: true },
    });
    await expect(defaultBuild).resolves.toMatchObject({
      default: { ok: true },
    });
  } finally {
    releaseFirstBuild.resolve();
    releaseSecondBuild.resolve();
    await builder.close();
  }
});

it('does not strand a profile waiter when a pending clean rebuild is aborted', async () => {
  /// @case
  /// 1. Two clean rebuilds are requested while the first watcher is still starting.
  /// 2. A default-profile caller observes the latest startup, then close aborts the pending second clean rebuild.
  /// @expect
  /// The pending clean rejection propagates to the profile caller instead of leaving its startup wait pending forever.
  const project = await makeTempDir();
  await fs.outputFile(join(project, 'oms.config.mjs'), 'export default { profiles: { headless: {} } };');
  await fs.outputFile(join(project, 'src', 'index.ts'), 'export const marker = "abort-pending-clean";');
  const ctx = new ServerContext({
    invoke: async () => undefined,
  } as any);
  const builder = new OmsBuilder(ctx, { project });

  const firstCleanBuild = builder.cleanRebuild();
  const pendingCleanBuild = builder.cleanRebuild();
  const defaultBuild = builder.rebuild({ profiles: ['default'] });
  const defaultBuildSettlement = defaultBuild.then(
    () => 'resolved',
    () => 'rejected',
  );
  const pendingCleanRejection = expect(pendingCleanBuild).rejects.toThrow('Task queue aborted');
  const close = builder.close();

  await pendingCleanRejection;
  await expect(firstCleanBuild).resolves.toMatchObject({
    default: { ok: true },
    headless: { ok: true },
  });
  await close;
  await expect(Promise.race([
    defaultBuildSettlement,
    setTimeout(1_000, 'timeout'),
  ])).resolves.not.toBe('timeout');
});

it('preserves a pending clean startup after an earlier clean startup fails', async () => {
  /// @case
  /// 1. An output-path conflict makes the active clean rebuild fail during watcher startup.
  /// 2. A second clean rebuild is already pending; the path is repaired before a default-profile request arrives.
  /// @expect
  /// The failed startup rolls back only its own resources, and the profile caller shares the pending clean startup successfully.
  const project = await makeTempDir();
  await fs.outputFile(join(project, 'oms.config.mjs'), 'export default { profiles: { headless: {} } };');
  await fs.outputFile(join(project, 'src', 'index.ts'), 'export const marker = "recover-pending-clean";');
  const blockedOutputPath = join(project, 'temp', 'oms', 'out');
  await fs.outputFile(blockedOutputPath, 'blocks the first clean startup');
  let buildStartCount = 0;
  const ctx = new ServerContext({
    invoke: async (method: string) => {
      if (method === 'build-start') {
        buildStartCount++;
      }
    },
  } as any);
  const builder = new OmsBuilder(ctx, { project });

  try {
    const failedCleanBuild = builder.cleanRebuild();
    const recoveredCleanBuild = builder.cleanRebuild();
    await expect(failedCleanBuild).rejects.toThrow();
    await fs.remove(blockedOutputPath);

    const defaultBuild = builder.rebuild({ profiles: ['default'] });
    await expect(defaultBuild).resolves.toMatchObject({
      default: { ok: true },
    });
    await expect(recoveredCleanBuild).resolves.toMatchObject({
      default: { ok: true },
      headless: { ok: true },
    });
    expect(buildStartCount).toBe(1);
  } finally {
    await fs.remove(blockedOutputPath);
    await builder.close();
  }
});

it('does not emit passive-build-end when an active waiter attaches to a pending passive build', async () => {
  const project = await makeTempDir();
  await fs.ensureDir(join(project, 'src'));
  const ctx = new ServerContext({
    invoke: async () => undefined,
  } as any);
  const builder = new OmsBuilder(ctx, {
    project,
  });

  try {
    await rebuildDefault(builder, {
      extensionBuildOptions: [],
    });

    const watcher = (builder as any)._watcher;
    expect(watcher).toBeTruthy();

    let unblock!: () => void;
    const blocker = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const blockTask = watcher._taskQueue.queueTask({
      type: 'inlineUUIDs',
      exec: async () => {
        await blocker;
      },
    });

    let passiveBuildEndCount = 0;
    builder.on('passive-build-end', () => {
      passiveBuildEndCount++;
    });

    watcher._queuePassiveBuild('test passive build');
    const activeBuild = watcher.build();
    unblock();

    await blockTask;
    await expect(activeBuild).resolves.toMatchObject({
      default: { ok: true },
      headless: { ok: true },
    });
    await setTimeout(50);

    expect(passiveBuildEndCount).toBe(0);
  } finally {
    await (builder as any)._clean();
  }
});

it('lets an active caller attach to a passive revision during preparation', async () => {
  /// @case
  /// 1. A source change starts a passive revision and pauses in its build-start notification.
  /// 2. An active default-profile caller arrives before profile execution begins.
  /// @expect
  /// The caller attaches to that revision, no second revision runs, and passive side effects are not emitted separately.
  const project = await makeTempDir();
  const entry = join(project, 'src', 'index.ts');
  await fs.outputFile(entry, 'export const marker = "before-active-attach";');
  const initialBuildEnd = deferred<void>();
  const passiveBuildStart = deferred<void>();
  const releasePassivePreparation = deferred<void>();
  let blockNextBuildStart = false;
  let buildStartCount = 0;
  const ctx = new ServerContext({
    invoke: async (method: string) => {
      if (method === 'build-start') {
        buildStartCount++;
        if (blockNextBuildStart) {
          blockNextBuildStart = false;
          passiveBuildStart.resolve();
          await releasePassivePreparation.promise;
        }
      } else if (method === 'build-end' && buildStartCount === 1) {
        initialBuildEnd.resolve();
      }
    },
  } as any);
  const builder = new OmsBuilder(ctx, { project });

  try {
    await expect(rebuildDefault(builder, {
      extensionBuildOptions: [],
      profiles: ['default'],
    })).resolves.toMatchObject({ ok: true });
    await initialBuildEnd.promise;

    let passiveBuildEndCount = 0;
    builder.on('passive-build-end', () => {
      passiveBuildEndCount++;
    });
    blockNextBuildStart = true;
    await fs.outputFile(entry, 'export const marker = "after-active-attach";');
    await passiveBuildStart.promise;

    const activeBuild = builder.rebuild({ profiles: ['default'] });
    releasePassivePreparation.resolve();
    await expect(activeBuild).resolves.toMatchObject({
      default: { ok: true },
    });
    await setTimeout(150);

    expect(buildStartCount).toBe(2);
    expect(passiveBuildEndCount).toBe(0);
  } finally {
    await builder.close();
  }
});

it('does not run a second default build from initial source discovery', async () => {
  /// @case
  /// 1. A fresh project contains many OMS extension domains before the first OMS rebuild.
  /// 2. Domain source roots are discovered during watcher startup and feed the initial source queue.
  /// @expect
  /// The initial source discovery is owned by that first rebuild and does not schedule a second build.
  const project = await makeTempDir();
  await fs.outputFile(join(project, 'src', 'index.ts'), 'export const main = 1;');
  const extensionBuildOptions: Array<{ name: string; path: string }> = [];
  const linkedExtensionTarget = join(project, 'linked-extension-target');
  await fs.outputJSON(join(linkedExtensionTarget, 'package.json'), {
    oms: {
      partitions: [
        {
          rootDir: 'src',
        },
      ],
    },
  });
  await fs.outputFile(join(linkedExtensionTarget, 'src', 'main.ts'), 'export const linkedMain = 1;');
  await fs.outputFile(join(linkedExtensionTarget, 'src', 'nested', 'late.component.ts'), 'export class LateComponent {}');
  await fs.ensureDir(join(project, 'extensions'));
  const linkedExtensionRoot = join(project, 'extensions', 'linked-extension');
  await fs.ensureSymlink(linkedExtensionTarget, linkedExtensionRoot, process.platform === 'win32' ? 'junction' : 'dir');
  extensionBuildOptions.push({
    name: 'linked-extension',
    path: linkedExtensionRoot,
  });
  for (let extensionIndex = 0; extensionIndex < 10; extensionIndex++) {
    const extensionRoot = join(project, 'extensions', `extension-${extensionIndex}`);
    extensionBuildOptions.push({
      name: `extension-${extensionIndex}`,
      path: extensionRoot,
    });
    if (extensionIndex === 0) {
      await fs.outputFile(join(extensionRoot, 'oms.config.mjs'), [
        'await new Promise((resolve) => setTimeout(resolve, 250));',
        'export default {};',
      ].join('\n'));
    }
    await fs.outputFile(join(extensionRoot, 'oms', 'src', 'index.ts'), `export const extension${extensionIndex} = ${extensionIndex};`);
    const moduleCount = extensionIndex === 0 ? 500 : 20;
    for (let moduleIndex = 0; moduleIndex < moduleCount; moduleIndex++) {
      await fs.outputFile(
        join(extensionRoot, 'oms', 'src', 'bulk', `module-${moduleIndex}.ts`),
        `export const value${extensionIndex}_${moduleIndex} = ${extensionIndex + moduleIndex};`,
      );
    }
  }

  let buildStartCount = 0;
  const ctx = new ServerContext({
    invoke: async (method: string) => {
      if (method === 'build-start') {
        buildStartCount++;
      }
    },
  } as any);
  const builder = new OmsBuilder(ctx, {
    project,
  });

  try {
    await expect(rebuildDefault(builder, {
      extensionBuildOptions,
    })).resolves.toMatchObject({
      ok: true,
    });
    await setTimeout(1000);

    expect(buildStartCount).toBe(1);
  } finally {
    await (builder as any)._clean();
  }
});

it('ignores late files outside OMS domain source roots', async () => {
  /// @case
  /// 1. An enabled extension has no OMS source directory and only creates ordinary extension source files later.
  /// 2. Chokidar reports those ordinary extension files after the first OMS build.
  /// @expect
  /// Files outside OMS domain source roots are ignored before they can schedule a passive build.
  const project = await makeTempDir();
  await fs.outputFile(join(project, 'src', 'index.ts'), 'export const main = 1;');
  const extensionRoot = join(project, 'extensions', 'plain-extension');
  await fs.outputJSON(join(extensionRoot, 'package.json'), {
    name: 'plain-extension',
  });

  let buildStartCount = 0;
  let passiveBuildEndCount = 0;
  const ctx = new ServerContext({
    invoke: async (method: string) => {
      if (method === 'build-start') {
        buildStartCount++;
      }
    },
  } as any);
  const builder = new OmsBuilder(ctx, {
    project,
  });
  builder.on('passive-build-end', () => {
    passiveBuildEndCount++;
  });

  try {
    await expect(rebuildDefault(builder, {
      extensionBuildOptions: [
        {
          name: 'plain-extension',
          path: extensionRoot,
        },
      ],
    })).resolves.toMatchObject({
      ok: true,
    });
    expect(buildStartCount).toBe(1);

    await fs.outputFile(join(extensionRoot, 'src', 'constants.ts'), 'export const ignored = true;');
    await setTimeout(1000);

    expect(passiveBuildEndCount).toBe(0);
    expect(buildStartCount).toBe(1);
  } finally {
    await (builder as any)._clean();
  }
});

it('coalesces a queued source delete with a same-path add', async () => {
  /// @case
  /// 1. A source file delete has been queued but the passive build has not consumed it yet.
  /// 2. The same source path is added again before that passive build runs.
  /// @expect
  /// The queued final operation keeps the source file present instead of consuming only the stale delete.
  const project = await makeTempDir();
  const component = join(project, 'src', 'recreated.component.ts');
  await fs.outputFile(component, 'export class RecreatedComponent {}');
  const ctx = new ServerContext({
    invoke: async () => undefined,
  } as any);
  const builder = new OmsBuilder(ctx, {
    project,
  });

  try {
    await expect(rebuildDefault(builder, {
      extensionBuildOptions: [],
    })).resolves.toMatchObject({
      ok: true,
    });

    const watcher = (builder as any)._watcher;
    watcher._sourceFiles.delete(component);
    watcher._fileQueue[component] = 'delete';

    expect(watcher._queueFileAdd(component)).toBe(true);
    expect(watcher._sourceFiles.has(component)).toBe(true);
    expect(watcher._fileQueue[component]).toBe('add');
  } finally {
    await (builder as any)._clean();
  }
});

it('rebuilds when domain source files are added, changed, and deleted', async () => {
  /// @case
  /// 1. The watcher is running after an initial OMS build.
  /// 2. A component source file is added, changed, and then deleted under a configured domain source root.
  /// @expect
  /// Domain source changes trigger passive builds and the generated bundle follows the final file state.
  const project = await makeTempDir();
  await fs.outputFile(join(project, 'src', 'index.ts'), 'export const main = 1;');
  const component = join(project, 'src', 'late.component.ts');
  const ctx = new ServerContext({
    invoke: async () => undefined,
  } as any);
  const builder = new OmsBuilder(ctx, {
    project,
  });

  try {
    await expect(rebuildDefault(builder, {
      extensionBuildOptions: [],
    })).resolves.toMatchObject({
      ok: true,
    });

    let passiveBuildEnd = waitForPassiveBuildEnd(builder);
    await fs.outputFile(component, '(globalThis as any).__omsDomainSourceMarker = "domain-source-added";');
    await expect(passiveBuildEnd).resolves.toMatchObject({
      profileResults: {
        default: { ok: true },
        headless: { ok: true },
      },
    });
    await expect(fs.readFile(join(project, 'temp', 'oms', 'out', 'bundle-main.js'), 'utf8')).resolves.toContain('domain-source-added');

    passiveBuildEnd = waitForPassiveBuildEnd(builder);
    await fs.outputFile(component, '(globalThis as any).__omsDomainSourceMarker = "domain-source-changed";');
    await expect(passiveBuildEnd).resolves.toMatchObject({
      profileResults: {
        default: { ok: true },
        headless: { ok: true },
      },
    });
    const changedOutput = await fs.readFile(join(project, 'temp', 'oms', 'out', 'bundle-main.js'), 'utf8');
    expect(changedOutput).toContain('domain-source-changed');
    expect(changedOutput).not.toContain('domain-source-added');

    passiveBuildEnd = waitForPassiveBuildEnd(builder);
    await fs.remove(component);
    await expect(passiveBuildEnd).resolves.toMatchObject({
      profileResults: {
        default: { ok: true },
        headless: { ok: true },
      },
    });
    await expect(fs.readFile(join(project, 'temp', 'oms', 'out', 'bundle-main.js'), 'utf8')).resolves.not.toContain('domain-source-changed');
  } finally {
    await (builder as any)._clean();
  }
});

it('emits OMS export module declarations without a generated tsconfig paths file', async () => {
  const project = await makeTempDir();
  const omsPackageRoot = join(import.meta.dirname, '..', '..', 'extension');
  await fs.ensureDir(join(project, 'src'));
  const extensionRoot = join(project, 'extensions', 'text-field');
  await fs.ensureDir(join(extensionRoot, 'oms', 'src'));
  await fs.outputFile(join(extensionRoot, 'exports', 'lib', 'runtime', 'index.js'), 'export const runtimeValue = 42;');
  await fs.outputFile(join(extensionRoot, 'exports', 'lib', 'editor', 'index.js'), 'export const editorValue = 7;');
  await fs.outputFile(join(extensionRoot, 'oms.config.mjs'), [
    'export default {',
    '  exportPackageName: "friendly-plugin",',
    '  exports: {',
    '    ".": "./exports/lib/runtime/index.js",',
    '    "./editor": "./exports/lib/editor/index.js",',
    '  },',
    '};',
  ].join('\n'));
  const ctx = new ServerContext({
    invoke: async () => undefined,
  } as any);
  const builder = new OmsBuilder(ctx, {
    project,
  });

  try {
    const previousOmsPackageRoot = process.env.OMS_PACKAGE_ROOT;
    try {
      process.env.OMS_PACKAGE_ROOT = omsPackageRoot;
      await expect(rebuildDefault(builder, {
        extensionBuildOptions: [
          {
            name: 'text-field',
            path: extensionRoot,
          },
        ],
      })).resolves.toMatchObject({
        ok: true,
      });
    } finally {
      if (previousOmsPackageRoot === undefined) {
        delete process.env.OMS_PACKAGE_ROOT;
      } else {
        process.env.OMS_PACKAGE_ROOT = previousOmsPackageRoot;
      }
    }

    await expect(fs.pathExists(join(project, 'temp', 'oms', 'out', 'tsconfig.json'))).resolves.toBe(false);
    await expect(fs.readFile(join(project, 'temp', 'oms', 'typing', 'index.d.ts'), 'utf8')).resolves.toBe([
      '// This file is generated by Oh My Script. Do not edit.',
      makeOmsTypesReference(project, 'typing', omsPackageRoot),
      '',
      'declare module "oms://friendly-plugin" {',
      '  export * from "@oms-exports/friendly-plugin";',
      '}',
      '',
      'declare module "oms://friendly-plugin/editor" {',
      '  export * from "@oms-exports/friendly-plugin__editor";',
      '}',
      '',
    ].join('\n'));
    const runtimePackage = await fs.readFile(join(project, 'temp', 'oms', 'typing', 'node_modules', '@oms-exports', 'friendly-plugin', 'index.d.ts'), 'utf8');
    expect(runtimePackage.replace(/\\/g, '/')).toContain('extensions/text-field/exports/lib/runtime/index.js');
  } finally {
    await (builder as any)._clean();
  }
});

it('generates OMS typing proxies from the real export entry path', async () => {
  const project = await makeTempDir();
  await fs.ensureDir(join(project, 'src'));
  const virtualStore = await makeTempDir();
  const realExtensionRoot = join(virtualStore, 'node_modules', 'linked-extension');
  const extensionRoot = join(project, 'extensions', 'linked-extension');
  await fs.ensureDir(join(project, 'extensions'));
  await fs.outputJson(join(realExtensionRoot, 'package.json'), {
    name: 'linked-extension',
    type: 'module',
  });
  await outputNodePackage(virtualStore, 'transitive-dep', 'export const X = 1;');
  await fs.outputJson(join(virtualStore, 'node_modules', 'transitive-dep', 'package.json'), {
    name: 'transitive-dep',
    type: 'module',
    main: './index.js',
    types: './index.d.ts',
  });
  await fs.outputFile(join(virtualStore, 'node_modules', 'transitive-dep', 'index.d.ts'), 'export declare const X: 1;');
  await fs.outputFile(join(realExtensionRoot, 'exports', 'lib', 'runtime', 'index.js'), 'export * from "transitive-dep";');
  await fs.outputFile(join(realExtensionRoot, 'exports', 'lib', 'runtime', 'index.d.ts'), 'export * from "transitive-dep";');
  await fs.outputFile(join(realExtensionRoot, 'oms.config.mjs'), [
    'export default {',
    '  exports: {',
    '    ".": "./exports/lib/runtime/index.js",',
    '  },',
    '};',
  ].join('\n'));
  await fs.ensureSymlink(realExtensionRoot, extensionRoot, 'junction');
  const ctx = new ServerContext({
    invoke: async () => undefined,
  } as any);
  const builder = new OmsBuilder(ctx, {
    project,
  });

  try {
    await expect(rebuildDefault(builder, {
      extensionBuildOptions: [
        {
          name: 'linked-extension',
          path: extensionRoot,
        },
      ],
    })).resolves.toMatchObject({
      ok: true,
    });

    const runtimePackagePath = join(project, 'temp', 'oms', 'typing', 'node_modules', '@oms-exports', 'linked-extension', 'index.d.ts');
    const runtimePackage = (await fs.readFile(runtimePackagePath, 'utf8')).replace(/\\/g, '/');
    expect(runtimePackage).not.toContain('/extensions/linked-extension/');

    const consumer = join(project, 'src', 'index.ts');
    await fs.outputFile(consumer, [
      'import { X } from "oms://linked-extension";',
      'const value: 1 = X;',
      'void value;',
      '',
    ].join('\n'));
    expect(typeCheck([consumer], {
      types: [
        join(project, 'temp', 'oms', 'typing'),
      ],
    })).toEqual([]);
  } finally {
    await (builder as any)._clean();
  }
});

it('resolves OMS peer imports from the project root', async () => {
  const project = await makeTempDir();
  await fs.ensureDir(join(project, 'src'));
  await fs.outputFile(join(project, 'oms.config.mjs'), [
    'export default {',
    '  resolve: {',
    '    projectPeers: ["peer-pkg"],',
    '  },',
    '};',
  ].join('\n'));
  const extensionRoot = join(project, 'extensions', 'peer-extension');
  await outputNodePackage(project, 'peer-pkg', 'export const origin = "project-peer-origin";');
  await outputNodePackage(extensionRoot, 'peer-pkg', 'export const origin = "extension-peer-origin";');
  await fs.outputFile(join(extensionRoot, 'exports', 'lib', 'runtime', 'index.js'), 'export { origin } from "#oms-peer:peer-pkg";');
  await fs.outputFile(join(extensionRoot, 'oms.config.mjs'), [
    'export default {',
    '  exports: {',
    '    ".": "./exports/lib/runtime/index.js",',
    '  },',
    '};',
  ].join('\n'));
  const ctx = new ServerContext({
    invoke: async () => undefined,
  } as any);
  const builder = new OmsBuilder(ctx, {
    project,
  });

  try {
    await expect(rebuildDefault(builder, {
      extensionBuildOptions: [
        {
          name: 'peer-extension',
          path: extensionRoot,
        },
      ],
    })).resolves.toMatchObject({
      ok: true,
    });

    const output = await fs.readFile(join(project, 'temp', 'oms', 'out', 'exports', 'peer-extension', 'index.js'), 'utf8');
    expect(output).toContain('project-peer-origin');
    expect(output).not.toContain('extension-peer-origin');
  } finally {
    await (builder as any)._clean();
  }
});

it('resolves OMS peer imports from dependencies outside the extension root', async () => {
  const project = await makeTempDir();
  await fs.ensureDir(join(project, 'src'));
  await fs.outputFile(join(project, 'oms.config.mjs'), [
    'export default {',
    '  resolve: {',
    '    projectPeers: ["peer-pkg"],',
    '  },',
    '};',
  ].join('\n'));
  const virtualPackageRoot = join(project, 'node_modules', '.pnpm', 'peer-extension@1');
  const realExtensionRoot = join(virtualPackageRoot, 'node_modules', 'peer-extension');
  const extensionRoot = join(project, 'extensions', 'peer-extension');
  await fs.ensureDir(join(project, 'extensions'));
  await fs.outputJson(join(realExtensionRoot, 'package.json'), {
    name: 'peer-extension',
    type: 'module',
  });
  await outputNodePackage(project, 'peer-pkg', 'export const origin = "project-peer-origin";');
  await outputNodePackage(virtualPackageRoot, 'peer-pkg', 'export const origin = "extension-peer-origin";');
  await outputNodePackage(virtualPackageRoot, 'owned-dep', 'export { origin } from "#oms-peer:peer-pkg";', {
    peerDependencies: {
      'peer-pkg': '*',
    },
  });
  await fs.outputFile(join(realExtensionRoot, 'exports', 'lib', 'runtime', 'index.js'), 'export { origin } from "owned-dep";');
  await fs.outputFile(join(realExtensionRoot, 'oms.config.mjs'), [
    'export default {',
    '  exports: {',
    '    ".": "./exports/lib/runtime/index.js",',
    '  },',
    '};',
  ].join('\n'));
  await fs.ensureSymlink(realExtensionRoot, extensionRoot, 'junction');
  const ctx = new ServerContext({
    invoke: async () => undefined,
  } as any);
  const builder = new OmsBuilder(ctx, {
    project,
  });

  try {
    await expect(rebuildDefault(builder, {
      extensionBuildOptions: [
        {
          name: 'peer-extension',
          path: extensionRoot,
        },
      ],
    })).resolves.toMatchObject({
      ok: true,
    });

    const output = await fs.readFile(join(project, 'temp', 'oms', 'out', 'exports', 'peer-extension', 'index.js'), 'utf8');
    expect(output).toContain('project-peer-origin');
    expect(output).not.toContain('extension-peer-origin');
  } finally {
    await (builder as any)._clean();
  }
});

it('fails OMS peer imports when the project does not provide the peer package', async () => {
  const project = await makeTempDir();
  await fs.ensureDir(join(project, 'src'));
  await fs.outputFile(join(project, 'oms.config.mjs'), [
    'export default {',
    '  resolve: {',
    '    projectPeers: ["peer-pkg"],',
    '  },',
    '};',
  ].join('\n'));
  const extensionRoot = join(project, 'extensions', 'peer-extension');
  const runtimeEntry = join(extensionRoot, 'exports', 'lib', 'runtime', 'index.js');
  await outputNodePackage(extensionRoot, 'peer-pkg', 'export const origin = "extension-peer-origin";');
  await fs.outputFile(runtimeEntry, 'export { origin } from "#oms-peer:peer-pkg";');
  await fs.outputFile(join(extensionRoot, 'oms.config.mjs'), [
    'export default {',
    '  exports: {',
    '    ".": "./exports/lib/runtime/index.js",',
    '  },',
    '};',
  ].join('\n'));
  const ctx = new ServerContext({
    invoke: async () => undefined,
  } as any);
  const builder = new OmsBuilder(ctx, {
    project,
  });

  try {
    await expect(rebuildDefault(builder, {
      extensionBuildOptions: [
        {
          name: 'peer-extension',
          path: extensionRoot,
        },
      ],
    })).resolves.toMatchObject({
      ok: false,
      error: {
        message: expect.stringContaining(`Failed to resolve OMS peer import #oms-peer:peer-pkg from ${runtimeEntry} via the project root`),
      },
    });
  } finally {
    await (builder as any)._clean();
  }
});

it('keeps alias and wasm support in the default Rollup runtime', async () => {
  /// @case
  /// 1. A project entry imports a TypeScript module through resolve.alias and a WebAssembly module by path.
  /// 2. The project runs the default bundled OMS runtime build.
  /// @expect
  /// Rollup resolves the alias, bundles its source, and emits the WebAssembly binary as an output asset.
  const project = await makeTempDir();
  const sourceDir = join(project, 'src');
  await fs.ensureDir(sourceDir);
  const aliasTarget = join(sourceDir, 'aliased.ts');
  await fs.outputFile(aliasTarget, 'export const aliasMarker = "resolved-through-rollup-alias";');
  await fs.outputFile(join(sourceDir, 'tiny.wasm'), Buffer.from([
    0x00, 0x61, 0x73, 0x6d,
    0x01, 0x00, 0x00, 0x00,
  ]));
  await fs.outputFile(join(project, 'oms.config.mjs'), [
    'export default {',
    '  resolve: {',
    `    alias: { "@oms-alias": ${JSON.stringify(aliasTarget)} },`,
    '  },',
    '};',
  ].join('\n'));
  await fs.outputFile(join(sourceDir, 'index.ts'), [
    'import { aliasMarker } from "@oms-alias";',
    'import wasmInstance from "./tiny.wasm";',
    'console.log(aliasMarker, wasmInstance);',
  ].join('\n'));
  const ctx = new ServerContext({
    invoke: async () => undefined,
  } as any);
  const builder = new OmsBuilder(ctx, {
    project,
  });

  try {
    await expect(rebuildDefault(builder, {
      extensionBuildOptions: [],
    })).resolves.toMatchObject({
      ok: true,
    });

    const outDir = join(project, 'temp', 'oms', 'out');
    const outputFiles = await fs.readdir(outDir, {
      recursive: true,
    });
    const javaScriptOutput = (await Promise.all(outputFiles
      .filter((file) => file.endsWith('.js'))
      .map(async (file) => await fs.readFile(join(outDir, file), 'utf8'))))
      .join('\n');
    expect(javaScriptOutput).toContain('resolved-through-rollup-alias');
    expect(outputFiles.some((file) => file.endsWith('.wasm'))).toBe(true);
  } finally {
    await (builder as any)._clean();
  }
}, 20_000);

it('replaces project define expressions during build', async () => {
  /// @case
  /// 1. The project declares JavaScript expression replacements in oms.config.mjs.
  /// 2. A source entry references those expressions and keeps the same token inside a string literal.
  /// @expect
  /// The emitted OMS bundle contains the configured expressions, while string literal text is untouched.
  const project = await makeTempDir();
  await fs.ensureDir(join(project, 'src'));
  await fs.outputFile(join(project, 'oms.config.mjs'), [
    'export default {',
    '  define: {',
    '    __OMS_STRING__: JSON.stringify("defined-value"),',
    '    __OMS_BOOL__: true,',
    '    __OMS_OBJECT__: { nested: 1 },',
    '  },',
    '};',
  ].join('\n'));
  await fs.outputFile(join(project, 'src', 'index.ts'), [
    'export const values = [',
    '  __OMS_STRING__,',
    '  __OMS_BOOL__,',
    '  __OMS_OBJECT__.nested,',
    '  "__OMS_STRING__",',
    '];',
  ].join('\n'));
  const ctx = new ServerContext({
    invoke: async () => undefined,
  } as any);
  const builder = new OmsBuilder(ctx, {
    project,
  });

  try {
    await expect(rebuildDefault(builder, {
      extensionBuildOptions: [],
    })).resolves.toMatchObject({
      ok: true,
    });

    const output = await fs.readFile(join(project, 'temp', 'oms', 'out', 'bundle-main.js'), 'utf8');
    expect(output).toContain('defined-value');
    expect(output).toContain('true');
    expect(output).toContain('nested');
    expect(output).toContain('"__OMS_STRING__"');
    expect(output).not.toContain('__OMS_BOOL__');
  } finally {
    await (builder as any)._clean();
  }
});

it('loads OMS-prefixed dotenv files into import.meta.env', async () => {
  /// @case
  /// 1. The project declares staging mode and the default OMS_ env prefix.
  /// 2. .env, .env.local, .env.staging, .env.staging.local, and process.env provide overlapping values.
  /// @expect
  /// import.meta.env uses Vite-like file priority, process env wins, unprefixed keys stay private, and unknown env reads become undefined.
  const project = await makeTempDir();
  await fs.ensureDir(join(project, 'src'));
  await fs.outputFile(join(project, 'oms.config.mjs'), [
    'export default {',
    '  mode: "staging",',
    '};',
  ].join('\n'));
  await fs.outputFile(join(project, '.env'), [
    'OMS_BASE=base',
    'OMS_SHARED=base',
    'OMS_EXPAND=${OMS_BASE}-expanded',
    'OMS_PROCESS=file',
    'PRIVATE_SECRET=hidden',
  ].join('\n'));
  await fs.outputFile(join(project, '.env.local'), [
    'OMS_SHARED=local',
  ].join('\n'));
  await fs.outputFile(join(project, '.env.staging'), [
    'OMS_SHARED=staging',
  ].join('\n'));
  await fs.outputFile(join(project, '.env.staging.local'), [
    'OMS_SHARED=staging-local',
  ].join('\n'));
  await fs.outputFile(join(project, 'src', 'index.ts'), [
    'export const values = [',
    '  import.meta.env.OMS_SHARED,',
    '  import.meta.env.OMS_EXPAND,',
    '  import.meta.env.OMS_PROCESS,',
    '  import.meta.env.PRIVATE_SECRET,',
    '  import.meta.env.MODE,',
    '  import.meta.env.DEV,',
    '  import.meta.env.PROD,',
    '  import.meta.env.UNKNOWN,',
    '  import.meta.env,',
    '];',
  ].join('\n'));
  const previousProcessValue = process.env.OMS_PROCESS;
  process.env.OMS_PROCESS = 'from-process';
  const ctx = new ServerContext({
    invoke: async () => undefined,
  } as any);
  const builder = new OmsBuilder(ctx, {
    project,
  });

  try {
    await expect(rebuildDefault(builder, {
      extensionBuildOptions: [],
    })).resolves.toMatchObject({
      ok: true,
    });

    const output = await fs.readFile(join(project, 'temp', 'oms', 'out', 'bundle-main.js'), 'utf8');
    expect(output).toContain('staging-local');
    expect(output).toContain('base-expanded');
    expect(output).toContain('from-process');
    expect(output).toContain('staging');
    expect(output).toContain('MODE');
    expect(output).not.toContain('PRIVATE_SECRET');
    expect(output).not.toContain('hidden');
    expect(output).not.toContain('import.meta.env');
  } finally {
    if (previousProcessValue === undefined) {
      delete process.env.OMS_PROCESS;
    } else {
      process.env.OMS_PROCESS = previousProcessValue;
    }
    await (builder as any)._clean();
  }
});

it('loads dotenv files from envDir during build', async () => {
  /// @case
  /// 1. The project points envDir to a custom directory and uses a non-default mode.
  /// 2. The source entry reads an OMS_ variable from that directory's mode-specific local file.
  /// @expect
  /// The emitted OMS bundle uses envDir and Vite-like mode file priority.
  const project = await makeTempDir();
  await fs.ensureDir(join(project, 'src'));
  await fs.outputFile(join(project, 'oms.config.mjs'), [
    'export default {',
    '  mode: "qa",',
    '  envDir: "config-env",',
    '};',
  ].join('\n'));
  await fs.outputFile(join(project, 'config-env', '.env'), 'OMS_FROM_DIR=base\n');
  await fs.outputFile(join(project, 'config-env', '.env.qa.local'), 'OMS_FROM_DIR=qa-local\n');
  await fs.outputFile(join(project, 'src', 'index.ts'), [
    'export const value = import.meta.env.OMS_FROM_DIR;',
  ].join('\n'));
  const ctx = new ServerContext({
    invoke: async () => undefined,
  } as any);
  const builder = new OmsBuilder(ctx, {
    project,
  });

  try {
    await expect(rebuildDefault(builder, {
      extensionBuildOptions: [],
    })).resolves.toMatchObject({
      ok: true,
    });

    const output = await fs.readFile(join(project, 'temp', 'oms', 'out', 'bundle-main.js'), 'utf8');
    expect(output).toContain('qa-local');
    expect(output).not.toContain('base');
  } finally {
    await (builder as any)._clean();
  }
});

it('respects custom envPrefix during build', async () => {
  /// @case
  /// 1. The project expands envPrefix to include PUBLIC_ alongside the default OMS_ prefix.
  /// 2. The env file also contains an unprefixed private value.
  /// @expect
  /// PUBLIC_ and OMS_ variables are exposed to import.meta.env, while unprefixed values stay out of the bundle.
  const project = await makeTempDir();
  await fs.ensureDir(join(project, 'src'));
  await fs.outputFile(join(project, 'oms.config.mjs'), [
    'export default {',
    '  envPrefix: ["OMS_", "PUBLIC_"],',
    '};',
  ].join('\n'));
  await fs.outputFile(join(project, '.env'), [
    'OMS_VALUE=oms-value',
    'PUBLIC_VALUE=public-value',
    'PRIVATE_SECRET=hidden',
  ].join('\n'));
  await fs.outputFile(join(project, 'src', 'index.ts'), [
    'export const values = [',
    '  import.meta.env.OMS_VALUE,',
    '  import.meta.env.PUBLIC_VALUE,',
    '  import.meta.env.PRIVATE_SECRET,',
    '];',
  ].join('\n'));
  const ctx = new ServerContext({
    invoke: async () => undefined,
  } as any);
  const builder = new OmsBuilder(ctx, {
    project,
  });

  try {
    await expect(rebuildDefault(builder, {
      extensionBuildOptions: [],
    })).resolves.toMatchObject({
      ok: true,
    });

    const output = await fs.readFile(join(project, 'temp', 'oms', 'out', 'bundle-main.js'), 'utf8');
    expect(output).toContain('oms-value');
    expect(output).toContain('public-value');
    expect(output).not.toContain('PRIVATE_SECRET');
    expect(output).not.toContain('hidden');
  } finally {
    await (builder as any)._clean();
  }
});

it('lets define override import.meta.env values', async () => {
  /// @case
  /// 1. The env file and project define both provide import.meta.env.OMS_OVERRIDE.
  /// 2. The source reads that value directly and from bare import.meta.env.
  /// @expect
  /// The define expression wins over the dotenv value in both replacement forms.
  const project = await makeTempDir();
  await fs.ensureDir(join(project, 'src'));
  await fs.outputFile(join(project, 'oms.config.mjs'), [
    'export default {',
    '  define: {',
    '    "import.meta.env.OMS_OVERRIDE": JSON.stringify("defined-value"),',
    '  },',
    '};',
  ].join('\n'));
  await fs.outputFile(join(project, '.env'), 'OMS_OVERRIDE=env-value\n');
  await fs.outputFile(join(project, 'src', 'index.ts'), [
    'export const direct = import.meta.env.OMS_OVERRIDE;',
    'export const envObject = import.meta.env;',
  ].join('\n'));
  const ctx = new ServerContext({
    invoke: async () => undefined,
  } as any);
  const builder = new OmsBuilder(ctx, {
    project,
  });

  try {
    await expect(rebuildDefault(builder, {
      extensionBuildOptions: [],
    })).resolves.toMatchObject({
      ok: true,
    });

    const output = await fs.readFile(join(project, 'temp', 'oms', 'out', 'bundle-main.js'), 'utf8');
    expect(output).toContain('defined-value');
    expect(output).not.toContain('env-value');
  } finally {
    await (builder as any)._clean();
  }
});

it('emits bare import.meta.env as an object with only public env keys', async () => {
  /// @case
  /// 1. A project source exports bare import.meta.env.
  /// 2. The env file contains both OMS_ public values and unprefixed private values.
  /// @expect
  /// The replacement object includes built-in metadata and public env values, but excludes private values.
  const project = await makeTempDir();
  await fs.ensureDir(join(project, 'src'));
  await fs.outputFile(join(project, '.env'), [
    'OMS_OBJECT=value-from-env',
    'PRIVATE_SECRET=hidden',
  ].join('\n'));
  await fs.outputFile(join(project, 'src', 'index.ts'), [
    'export const envObject = import.meta.env;',
  ].join('\n'));
  const ctx = new ServerContext({
    invoke: async () => undefined,
  } as any);
  const builder = new OmsBuilder(ctx, {
    project,
  });

  try {
    await expect(rebuildDefault(builder, {
      extensionBuildOptions: [],
    })).resolves.toMatchObject({
      ok: true,
    });

    const output = await fs.readFile(join(project, 'temp', 'oms', 'out', 'bundle-main.js'), 'utf8');
    expect(output).toContain('OMS_OBJECT');
    expect(output).toContain('value-from-env');
    expect(output).toContain('MODE');
    expect(output).toContain('DEV');
    expect(output).not.toContain('PRIVATE_SECRET');
    expect(output).not.toContain('hidden');
    expect(output).not.toContain('import.meta.env');
  } finally {
    await (builder as any)._clean();
  }
});

it('fails build when project mode is local', async () => {
  /// @case
  /// 1. A project config sets mode to local.
  /// 2. The build tries to load dotenv files.
  /// @expect
  /// The build fails with a clear error because .local suffixes are reserved for env files.
  const project = await makeTempDir();
  await fs.ensureDir(join(project, 'src'));
  await fs.outputFile(join(project, 'oms.config.mjs'), [
    'export default {',
    '  mode: "local",',
    '};',
  ].join('\n'));
  await fs.outputFile(join(project, 'src', 'index.ts'), [
    'export const value = import.meta.env.MODE;',
  ].join('\n'));
  const ctx = new ServerContext({
    invoke: async () => undefined,
  } as any);
  const builder = new OmsBuilder(ctx, {
    project,
  });

  try {
    await expect(rebuildDefault(builder, {
      extensionBuildOptions: [],
    })).resolves.toMatchObject({
      ok: false,
      error: {
        message: expect.stringContaining('"local" cannot be used as OMS mode'),
      },
    });
  } finally {
    await (builder as any)._clean();
  }
});

it('builds default and headless as independent profiles in development and production', async () => {
  /// @case
  /// 1. A project excludes authority components from default and includes shared plus authority components in headless.
  /// 2. The development default build enables its editor overlay, while production builds select only their primary profile.
  /// @expect
  /// Preview and production keep the configured profile boundary, the editor overlay restores every filtered component, and UUID registration remains source-level.
  const project = await makeTempDir();
  const defaultProdDir = join(await makeTempDir(), 'default-build');
  const headlessProdDir = join(await makeTempDir(), 'headless-build');
  await fs.outputFile(join(project, 'oms.config.mjs'), [
    'export default {',
    '  profiles: {',
    '    default: { exclude: ["src/authority/**"] },',
    '    headless: {',
    '      include: ["src/shared/**", "src/authority/**"],',
    '      exclude: ["src/shared/headless-excluded/**"],',
    '    },',
    '  },',
    '  exports: { "./dynamic": "./src/shared/dynamic-export.ts" },',
    '};',
  ].join('\n'));
  await fs.outputFile(join(project, 'src', 'index.ts'), [
    'import "./authority/explicit-dependency.js";',
    'globalThis.__omsDefaultEntry = "default-entry-marker";',
  ].join('\n'));
  await fs.outputFile(join(project, 'src', 'index.headless.ts'), 'globalThis.__omsHeadlessEntry = "headless-entry-marker";');
  await fs.outputFile(join(project, 'src', 'authority', 'explicit-dependency.ts'), 'globalThis.__omsExplicitAuthorityDependency = "explicit-authority-dependency-marker";');
  await fs.outputFile(join(project, 'src', 'shared', 'dynamic-export.ts'), 'globalThis.__omsDynamicExport = "dynamic-export-marker";');
  await fs.outputFile(join(project, 'src', 'client', 'client-only.component.ts'), [
    '/// <meta "uuid"="11111111-1111-4111-8111-111111111111"/>',
    'globalThis.__omsClientComponent = "client-component-marker";',
  ].join('\n'));
  await fs.outputFile(join(project, 'src', 'client', 'client-tool.component.editor.ts'), [
    '/// <meta "uuid"="55555555-5555-4555-8555-555555555555"/>',
    'globalThis.__omsClientEditorComponent = "client-editor-component-marker";',
  ].join('\n'));
  await fs.outputFile(join(project, 'src', 'shared', 'shared.component.ts'), [
    '/// <meta "uuid"="22222222-2222-4222-8222-222222222222"/>',
    'globalThis.__omsSharedComponent = "shared-component-marker";',
  ].join('\n'));
  await fs.outputFile(join(project, 'src', 'shared', 'headless-excluded', 'excluded.component.ts'), [
    '/// <meta "uuid"="66666666-6666-4666-8666-666666666666"/>',
    'globalThis.__omsHeadlessExcludedComponent = "headless-excluded-component-marker";',
  ].join('\n'));
  await fs.outputFile(join(project, 'src', 'authority', 'authority.component.ts'), [
    '/// <meta "uuid"="33333333-3333-4333-8333-333333333333"/>',
    'globalThis.__omsAuthorityComponent = "authority-component-marker";',
  ].join('\n'));
  await fs.outputFile(join(project, 'src', 'authority', 'authority-tool.component.editor.ts'), [
    '/// <meta "uuid"="77777777-7777-4777-8777-777777777777"/>',
    'globalThis.__omsAuthorityEditorComponent = "authority-editor-component-marker";',
  ].join('\n'));
  const ctx = new ServerContext({
    invoke: async () => undefined,
  } as any);
  const builder = new OmsBuilder(ctx, {
    project,
  });

  try {
    await expect(rebuildDefault(builder, {
      extensionBuildOptions: [],
    })).resolves.toMatchObject({
      ok: true,
    });

    const defaultDevelopmentOutput = await readJavaScriptOutput(join(project, 'temp', 'oms', 'out'));
    const headlessDevelopmentOutput = await readJavaScriptOutput(join(project, 'temp', 'oms', 'out-headless'));
    expectProfileOutput(defaultDevelopmentOutput, {
      includes: [
        'default-entry-marker',
        'client-component-marker',
        'client-editor-component-marker',
        'shared-component-marker',
        'headless-excluded-component-marker',
        'authority-component-marker',
        'authority-editor-component-marker',
        'explicit-authority-dependency-marker',
        'dynamic-export-marker',
      ],
      excludes: ['headless-entry-marker'],
    });
    expectProfileOutput(await fs.readFile(join(project, 'temp', 'oms', 'out', 'bundle-main.js'), 'utf8'), {
      includes: [
        'client-component-marker',
        'shared-component-marker',
        'headless-excluded-component-marker',
        'explicit-authority-dependency-marker',
      ],
      excludes: [
        'client-editor-component-marker',
        'authority-component-marker',
        'authority-editor-component-marker',
      ],
    });
    expectProfileOutput(await fs.readFile(join(project, 'temp', 'oms', 'out', 'bundle-main.editor.js'), 'utf8'), {
      includes: [
        'client-editor-component-marker',
        'authority-component-marker',
        'authority-editor-component-marker',
      ],
      excludes: [
        'client-component-marker',
        'shared-component-marker',
        'headless-excluded-component-marker',
      ],
    });
    expectProfileOutput(headlessDevelopmentOutput, {
      includes: ['headless-entry-marker', 'shared-component-marker', 'authority-component-marker'],
      excludes: [
        'default-entry-marker',
        'client-component-marker',
        'client-editor-component-marker',
        'headless-excluded-component-marker',
        'authority-editor-component-marker',
        'dynamic-export-marker',
      ],
    });

    const defaultMetadata = await fs.readFile(join(project, 'temp', 'oms', 'out', 'metadata.js'), 'utf8');
    const headlessMetadata = await fs.readFile(join(project, 'temp', 'oms', 'out-headless', 'metadata.js'), 'utf8');
    expect(defaultMetadata).toContain("['main', false]");
    expect(defaultMetadata).toContain("['main.editor', true]");
    expect(defaultMetadata).not.toContain('main.headless');
    expect(defaultMetadata).toContain('main:dynamic');
    expect(headlessMetadata).toContain("['main.headless', false]");
    expect(headlessMetadata).not.toContain("['main', false]");
    expect(headlessMetadata).not.toContain('main:dynamic');
    await expect(fs.readJSON(join(project, 'temp', 'oms', 'out', 'package.json'))).resolves.toEqual({ type: 'commonjs' });
    await expect(fs.readJSON(join(project, 'temp', 'oms', 'out-headless', 'package.json'))).resolves.toEqual({ type: 'module' });

    const emittedUUIDs = await fs.readJSON(join(project, 'temp', 'oms', 'uuids.json')) as Record<string, string>;
    const sharedUUIDEntries = Object.entries(emittedUUIDs).filter(([file]) => file.endsWith(join('src', 'shared', 'shared.component.ts')));
    expect(sharedUUIDEntries).toEqual([
      [expect.any(String), '22222222-2222-4222-8222-222222222222'],
    ]);
    const filteredEditorUUIDEntries = Object.entries(emittedUUIDs).filter(([file]) => file.endsWith(join('src', 'authority', 'authority-tool.component.editor.ts')));
    expect(filteredEditorUUIDEntries).toEqual([
      [expect.any(String), '77777777-7777-4777-8777-777777777777'],
    ]);

    await builder.buildProd({
      buildDir: defaultProdDir,
      debug: false,
      sourceMaps: false,
      platform: 'web',
      headless: false,
    });
    await builder.buildProd({
      buildDir: headlessProdDir,
      debug: false,
      sourceMaps: false,
      platform: 'nodejs',
      headless: true,
    });

    expectProfileOutput(await readJavaScriptOutput(join(defaultProdDir, 'oms')), {
      includes: [
        'default-entry-marker',
        'client-component-marker',
        'shared-component-marker',
        'headless-excluded-component-marker',
        'explicit-authority-dependency-marker',
        'dynamic-export-marker',
      ],
      excludes: [
        'headless-entry-marker',
        'client-editor-component-marker',
        'authority-component-marker',
        'authority-editor-component-marker',
      ],
    });
    expectProfileOutput(await readJavaScriptOutput(join(headlessProdDir, 'oms')), {
      includes: ['headless-entry-marker', 'shared-component-marker', 'authority-component-marker'],
      excludes: [
        'default-entry-marker',
        'client-component-marker',
        'client-editor-component-marker',
        'headless-excluded-component-marker',
        'authority-editor-component-marker',
        'dynamic-export-marker',
      ],
    });

    const lateSharedComponent = join(project, 'src', 'shared', 'late-shared.component.ts');
    let passiveBuild = waitForPassiveBuildEnd(builder);
    await fs.outputFile(lateSharedComponent, [
      '/// <meta "uuid"="44444444-4444-4444-8444-444444444444"/>',
      'globalThis.__omsLateSharedComponent = "late-shared-component-marker";',
    ].join('\n'));
    await expect(passiveBuild).resolves.toMatchObject({
      profileResults: {
        default: { ok: true },
        headless: { ok: true },
      },
    });
    expect(await readJavaScriptOutput(join(project, 'temp', 'oms', 'out'))).toContain('late-shared-component-marker');
    expect(await readJavaScriptOutput(join(project, 'temp', 'oms', 'out-headless'))).toContain('late-shared-component-marker');

    passiveBuild = waitForPassiveBuildEnd(builder);
    await fs.remove(lateSharedComponent);
    await expect(passiveBuild).resolves.toMatchObject({
      profileResults: {
        default: { ok: true },
        headless: { ok: true },
      },
    });
    expect(await readJavaScriptOutput(join(project, 'temp', 'oms', 'out'))).not.toContain('late-shared-component-marker');
    expect(await readJavaScriptOutput(join(project, 'temp', 'oms', 'out-headless'))).not.toContain('late-shared-component-marker');

    const lateAuthorityComponent = join(project, 'src', 'authority', 'late-authority.component.ts');
    passiveBuild = waitForPassiveBuildEnd(builder);
    await fs.outputFile(lateAuthorityComponent, [
      '/// <meta "uuid"="99999999-9999-4999-8999-999999999999"/>',
      'globalThis.__omsLateAuthorityComponent = "late-authority-component-marker";',
    ].join('\n'));
    await expect(passiveBuild).resolves.toMatchObject({
      profileResults: {
        default: { ok: true },
        headless: { ok: true },
      },
    });
    expect(await fs.readFile(join(project, 'temp', 'oms', 'out', 'bundle-main.js'), 'utf8')).not.toContain('late-authority-component-marker');
    expect(await fs.readFile(join(project, 'temp', 'oms', 'out', 'bundle-main.editor.js'), 'utf8')).toContain('late-authority-component-marker');
    expect(await readJavaScriptOutput(join(project, 'temp', 'oms', 'out-headless'))).toContain('late-authority-component-marker');

    passiveBuild = waitForPassiveBuildEnd(builder);
    await fs.remove(lateAuthorityComponent);
    await expect(passiveBuild).resolves.toMatchObject({
      profileResults: {
        default: { ok: true },
        headless: { ok: true },
      },
    });
    expect(await readJavaScriptOutput(join(project, 'temp', 'oms', 'out'))).not.toContain('late-authority-component-marker');
    expect(await readJavaScriptOutput(join(project, 'temp', 'oms', 'out-headless'))).not.toContain('late-authority-component-marker');

    passiveBuild = waitForPassiveBuildEnd(builder);
    await fs.outputFile(join(project, 'oms.config.mjs'), [
      'export default {',
      '  profiles: {',
      '    default: { exclude: ["src/authority/**"] },',
      '    headless: { include: ["src/authority/**"] },',
      '  },',
      '};',
    ].join('\n'));
    await expect(passiveBuild).resolves.toMatchObject({
      profileResults: {
        default: { ok: true },
        headless: { ok: true },
      },
    });
    expect(await readJavaScriptOutput(join(project, 'temp', 'oms', 'out'))).toContain('shared-component-marker');
    expect(await readJavaScriptOutput(join(project, 'temp', 'oms', 'out-headless'))).not.toContain('shared-component-marker');

    passiveBuild = waitForPassiveBuildEnd(builder);
    await fs.outputFile(join(project, 'oms.config.mjs'), [
      'export default {',
      '  profiles: {',
      '    default: { exclude: ["src/authority/**"] },',
      '  },',
      '};',
    ].join('\n'));
    await expect(passiveBuild).resolves.toMatchObject({
      profileResults: {
        default: { ok: true },
        headless: { ok: true },
      },
    });
    await expect(fs.pathExists(join(project, 'temp', 'oms', 'out-headless'))).resolves.toBe(false);

    passiveBuild = waitForPassiveBuildEnd(builder);
    await fs.outputFile(join(project, 'oms.config.mjs'), [
      'export default {',
      '  profiles: {',
      '    default: { exclude: ["src/authority/**"] },',
      '    headless: { include: ["src/authority/**"] },',
      '  },',
      '};',
    ].join('\n'));
    await expect(passiveBuild).resolves.toMatchObject({
      profileResults: {
        default: { ok: true },
        headless: { ok: true },
      },
    });
    expect(await readJavaScriptOutput(join(project, 'temp', 'oms', 'out-headless'))).toContain('authority-component-marker');
  } finally {
    await (builder as any)._clean();
  }
});

it('moves the last filtered component between primary and editor bundles after a config hot update', async () => {
  /// @case
  /// 1. A project without an index initially builds one automatically scanned component.
  /// 2. A development-context project config hot update excludes every source from the default primary, then removes the exclusion.
  /// @expect
  /// The watcher retains its creation mode, and the component moves into the editor overlay and back while obsolete bundle files are removed.
  const project = await makeTempDir();
  const outDir = join(project, 'temp', 'oms', 'out');
  await fs.outputFile(join(project, 'oms.config.mjs'), [
    'export default ({ mode }) => ({',
    '  define: { __OMS_WATCHER_MODE__: JSON.stringify(mode) },',
    '  profiles: { default: {} },',
    '});',
  ].join('\n'));
  await fs.outputFile(join(project, 'src', 'only.component.ts'), [
    '/// <meta "uuid"="88888888-8888-4888-8888-888888888888"/>',
    'globalThis.__omsOnlyComponent = "only-component-marker";',
    'globalThis.__omsWatcherMode = __OMS_WATCHER_MODE__;',
  ].join('\n'));
  const ctx = new ServerContext({
    invoke: async () => undefined,
  } as any);
  const builder = new OmsBuilder(ctx, {
    project,
  });

  try {
    await expect(rebuildDefault(builder, {
      extensionBuildOptions: [],
    })).resolves.toMatchObject({ ok: true });
    expect(await readJavaScriptOutput(outDir)).toContain('only-component-marker');
    expect(await readJavaScriptOutput(outDir)).toContain('development');

    const passiveBuild = waitForPassiveBuildEnd(builder);
    await fs.outputFile(join(project, 'oms.config.mjs'), [
      'export default ({ mode }) => ({',
      '  define: { __OMS_WATCHER_MODE__: JSON.stringify(mode) },',
      '  profiles: { default: { exclude: ["src/**"] } },',
      '});',
    ].join('\n'));
    await expect(passiveBuild).resolves.toMatchObject({
      profileResults: {
        default: { ok: true },
        headless: { ok: true },
      },
    });

    expect(await readJavaScriptOutput(outDir)).toContain('only-component-marker');
    await expect(fs.pathExists(join(outDir, 'bundle-main.js'))).resolves.toBe(false);
    await expect(fs.readFile(join(outDir, 'bundle-main.editor.js'), 'utf8')).resolves.toContain('only-component-marker');
    await expect(fs.readFile(join(outDir, 'bundle-main.editor.js'), 'utf8')).resolves.toContain('development');
    await expect(fs.readFile(join(outDir, 'metadata.js'), 'utf8')).resolves.toContain("['main.editor', true]");

    const restoredBuild = waitForPassiveBuildEnd(builder);
    await fs.outputFile(join(project, 'oms.config.mjs'), [
      'export default ({ mode }) => ({',
      '  define: { __OMS_WATCHER_MODE__: JSON.stringify(mode) },',
      '  profiles: { default: {} },',
      '});',
    ].join('\n'));
    await expect(restoredBuild).resolves.toMatchObject({
      profileResults: {
        default: { ok: true },
        headless: { ok: true },
      },
    });

    await expect(fs.readFile(join(outDir, 'bundle-main.js'), 'utf8')).resolves.toContain('only-component-marker');
    await expect(fs.pathExists(join(outDir, 'bundle-main.editor.js'))).resolves.toBe(false);
    await expect(fs.readFile(join(outDir, 'metadata.js'), 'utf8')).resolves.not.toContain("['main.editor', true]");
  } finally {
    await (builder as any)._clean();
  }
});

it('initializes an empty headless profile after a config hot update', async () => {
  /// @case
  /// 1. An empty project starts without a headless profile and completes its initial default build.
  /// 2. A config hot update enables headless with an explicit empty component include list.
  /// @expect
  /// The new headless build is rebuilt from current profile entries and emits its empty metadata entry.
  const project = await makeTempDir();
  const headlessOutDir = join(project, 'temp', 'oms', 'out-headless');
  await fs.ensureDir(join(project, 'src'));
  await fs.outputFile(join(project, 'oms.config.mjs'), [
    'export default {',
    '  profiles: { default: {} },',
    '};',
  ].join('\n'));
  const ctx = new ServerContext({
    invoke: async () => undefined,
  } as any);
  const builder = new OmsBuilder(ctx, {
    project,
  });

  try {
    await expect(rebuildDefault(builder, {
      extensionBuildOptions: [],
    })).resolves.toMatchObject({ ok: true });

    const passiveBuild = waitForPassiveBuildEnd(builder);
    await fs.outputFile(join(project, 'oms.config.mjs'), [
      'export default {',
      '  profiles: {',
      '    default: {},',
      '    headless: { include: [] },',
      '  },',
      '};',
    ].join('\n'));
    await expect(passiveBuild).resolves.toMatchObject({
      profileResults: {
        default: { ok: true },
        headless: { ok: true },
      },
    });

    await expect(fs.pathExists(join(headlessOutDir, 'metadata.js'))).resolves.toBe(true);
    expect(await fs.readFile(join(headlessOutDir, 'metadata.js'), 'utf8')).not.toContain('main.headless');
  } finally {
    await (builder as any)._clean();
  }
});

it('uses production mode for prod builds', async () => {
  /// @case
  /// 1. A project entry branches on import.meta.env.PROD and cc/env BUILD.
  /// 2. The regular watcher build initializes domains, then buildProd emits a production bundle.
  /// @expect
  /// The prod bundle sees import.meta.env.PROD as true, import.meta.env.DEV as false, and cc/env BUILD as true.
  const project = await makeTempDir();
  const buildDir = join(await makeTempDir(), 'build');
  await fs.ensureDir(join(project, 'src'));
  await fs.outputFile(join(project, 'src', 'index.ts'), [
    'import { BUILD } from "cc/env";',
    'export const value = import.meta.env.PROD && !import.meta.env.DEV ? "prod-branch" : "dev-branch";',
    'export const buildValue = BUILD ? "build-mode" : "not-build-mode";',
  ].join('\n'));
  const ctx = new ServerContext({
    invoke: async () => undefined,
  } as any);
  const builder = new OmsBuilder(ctx, {
    project,
  });

  try {
    await expect(rebuildDefault(builder, {
      extensionBuildOptions: [],
    })).resolves.toMatchObject({
      ok: true,
    });
    await builder.buildProd({
      buildDir,
      debug: false,
      sourceMaps: false,
      platform: 'web',
      headless: false,
    });

    const output = await fs.readFile(join(buildDir, 'oms', 'bundle-main.js'), 'utf8');
    expect(output).toContain('prod-branch');
    expect(output).not.toContain('dev-branch');
    expect(output).toContain('build-mode');
    expect(output).not.toContain('not-build-mode');
  } finally {
    await (builder as any)._clean();
  }
});

it('builds production from mode-specific project and extension configs without mutating development', async () => {
  /// @case
  /// 1. Project and extension configs select sources and profile exclusions from the supplied mode.
  /// 2. Production excludes auto-collected development components, while the project explicitly imports another excluded component.
  /// 3. A source update runs through the original development watcher after production completes.
  /// @expect
  /// Development and production use independent config graphs, editor exports stay development-only, explicit imports survive filtering, and production never contaminates later development rebuilds.
  const project = await makeTempDir();
  const buildDir = join(await makeTempDir(), 'build');
  const extensionRoot = join(project, 'extensions', 'mode-extension');
  await fs.outputFile(join(project, 'oms.config.mjs'), [
    'export default ({ mode }) => ({',
    '  define: { __OMS_CONFIG_CONTEXT__: JSON.stringify(`project-${mode}`) },',
    '  exports: {',
    '    "./editor": "./src/editor-export.ts",',
    '    "./editor/tools": "./src/editor-tools-export.ts",',
    '  },',
    '  profiles: {',
    '    default: {',
    '      exclude: mode === "production" ? ["src/development-only/**"] : [],',
    '    },',
    '  },',
    '});',
  ].join('\n'));
  await fs.outputFile(join(project, 'src', 'index.ts'), [
    'import "./development-only/explicit.component.js";',
    'import { modeExtensionValue } from "oms://mode-extension";',
    'globalThis.__omsConfigContext = __OMS_CONFIG_CONTEXT__;',
    'globalThis.__omsModeExtensionValue = modeExtensionValue;',
  ].join('\n'));
  await fs.outputFile(join(project, 'src', 'runtime.component.ts'), 'globalThis.__omsRuntimeMarker = "runtime-v1-marker";');
  await fs.outputFile(join(project, 'src', 'development-only', 'auto.component.ts'), 'globalThis.__omsAutoDevelopmentMarker = "auto-development-marker";');
  await fs.outputFile(join(project, 'src', 'development-only', 'explicit.component.ts'), 'globalThis.__omsExplicitDevelopmentMarker = "explicit-development-marker";');
  await fs.outputFile(join(project, 'src', 'editor-export.ts'), 'export const editorValue = "project-editor-export-marker";');
  await fs.outputFile(join(project, 'src', 'editor-tools-export.ts'), 'export const editorToolsValue = "project-editor-tools-export-marker";');
  await fs.outputFile(join(extensionRoot, 'oms.config.mjs'), [
    'export default async ({ mode }) => ({',
    '  exports: {',
    '    ".": mode === "production" ? "./oms/src/production.ts" : "./oms/src/development.ts",',
    '    "./editor": "./oms/src/editor.ts",',
    '    "./editor/tools": "./oms/src/editor-tools.ts",',
    '  },',
    '});',
  ].join('\n'));
  await fs.outputFile(join(extensionRoot, 'oms', 'src', 'development.ts'), 'export const modeExtensionValue = "extension-development-marker";');
  await fs.outputFile(join(extensionRoot, 'oms', 'src', 'production.ts'), 'export const modeExtensionValue = "extension-production-marker";');
  await fs.outputFile(join(extensionRoot, 'oms', 'src', 'editor.ts'), 'export const editorValue = "extension-editor-export-marker";');
  await fs.outputFile(join(extensionRoot, 'oms', 'src', 'editor-tools.ts'), 'export const editorToolsValue = "extension-editor-tools-export-marker";');
  const ctx = new ServerContext({
    invoke: async () => undefined,
  } as any);
  const builder = new OmsBuilder(ctx, {
    project,
  });

  try {
    await expect(rebuildDefault(builder, {
      extensionBuildOptions: [{ name: 'mode-extension', path: extensionRoot }],
    })).resolves.toMatchObject({ ok: true });

    const developmentOutDir = join(project, 'temp', 'oms', 'out');
    const developmentOutput = await readJavaScriptOutput(developmentOutDir);
    expectProfileOutput(developmentOutput, {
      includes: [
        'project-development',
        'extension-development-marker',
        'auto-development-marker',
        'explicit-development-marker',
        'runtime-v1-marker',
      ],
      excludes: ['project-production', 'extension-production-marker'],
    });
    await expect(fs.pathExists(join(developmentOutDir, 'exports', 'main', 'editor.js'))).resolves.toBe(true);
    await expect(fs.pathExists(join(developmentOutDir, 'exports', 'main', 'editor', 'tools.js'))).resolves.toBe(true);
    await expect(fs.pathExists(join(developmentOutDir, 'exports', 'mode-extension', 'editor.js'))).resolves.toBe(true);
    await expect(fs.pathExists(join(developmentOutDir, 'exports', 'mode-extension', 'editor', 'tools.js'))).resolves.toBe(true);

    await builder.buildProd({
      buildDir,
      debug: true,
      sourceMaps: false,
      platform: 'web',
      headless: false,
    });

    const productionOutDir = join(buildDir, 'oms');
    const productionOutput = await readJavaScriptOutput(productionOutDir);
    expectProfileOutput(productionOutput, {
      includes: [
        'project-production',
        'extension-production-marker',
        'explicit-development-marker',
        'runtime-v1-marker',
      ],
      excludes: [
        'project-development',
        'extension-development-marker',
        'auto-development-marker',
        'project-editor-export-marker',
        'project-editor-tools-export-marker',
        'extension-editor-export-marker',
        'extension-editor-tools-export-marker',
      ],
    });
    await expect(fs.pathExists(join(productionOutDir, 'exports', 'main', 'editor.js'))).resolves.toBe(false);
    await expect(fs.pathExists(join(productionOutDir, 'exports', 'main', 'editor', 'tools.js'))).resolves.toBe(false);
    await expect(fs.pathExists(join(productionOutDir, 'exports', 'mode-extension', 'editor.js'))).resolves.toBe(false);
    await expect(fs.pathExists(join(productionOutDir, 'exports', 'mode-extension', 'editor', 'tools.js'))).resolves.toBe(false);
    await expect(fs.readFile(join(productionOutDir, 'metadata.js'), 'utf8')).resolves.not.toContain(':editor');

    const passiveBuild = waitForPassiveBuildEnd(builder);
    await fs.outputFile(join(project, 'src', 'runtime.component.ts'), 'globalThis.__omsRuntimeMarker = "runtime-v2-marker";');
    await expect(passiveBuild).resolves.toMatchObject({
      profileResults: {
        default: { ok: true },
        headless: { ok: true },
      },
    });

    const rebuiltDevelopmentOutput = await readJavaScriptOutput(developmentOutDir);
    expectProfileOutput(rebuiltDevelopmentOutput, {
      includes: [
        'project-development',
        'extension-development-marker',
        'auto-development-marker',
        'runtime-v2-marker',
      ],
      excludes: ['project-production', 'extension-production-marker', 'runtime-v1-marker'],
    });
  } finally {
    await (builder as any)._clean();
  }
});

it.each(['editor', 'editor/tools'])('rejects an explicit editor-only OMS import from production: %s', async (exportId) => {
  /// @case
  /// 1. A project publishes editor and editor/* exports that remain usable by development builds.
  /// 2. A runtime source explicitly imports one of those reserved editor-only OMS IDs.
  /// @expect
  /// Development can resolve the export, while production rejects the import instead of tracing editor code into the runtime bundle.
  const project = await makeTempDir();
  const buildDir = join(await makeTempDir(), 'build');
  await fs.outputFile(join(project, 'oms.config.mjs'), [
    'export default {',
    '  exports: {',
    '    "./editor": "./src/editor.ts",',
    '    "./editor/tools": "./src/editor-tools.ts",',
    '  },',
    '};',
  ].join('\n'));
  await fs.outputFile(join(project, 'src', 'index.ts'), [
    `import { editorValue } from "oms://main/${exportId}";`,
    'globalThis.__omsEditorImport = editorValue;',
  ].join('\n'));
  await fs.outputFile(join(project, 'src', 'editor.ts'), 'export const editorValue = "editor-root-runtime-leak-marker";');
  await fs.outputFile(join(project, 'src', 'editor-tools.ts'), 'export const editorValue = "editor-tools-runtime-leak-marker";');
  const ctx = new ServerContext({
    invoke: async () => undefined,
  } as any);
  const builder = new OmsBuilder(ctx, {
    project,
  });

  try {
    await expect(rebuildDefault(builder, { extensionBuildOptions: [] })).resolves.toMatchObject({ ok: true });
    await expect(builder.buildProd({
      buildDir,
      debug: true,
      sourceMaps: false,
      platform: 'web',
      headless: false,
    })).rejects.toThrow(new RegExp(`Editor-only OMS import .*main/${exportId.replace('/', '\\/')}.*production`));
  } finally {
    await (builder as any)._clean();
  }
});

it('propagates an async production config failure and recovers on the next production build', async () => {
  /// @case
  /// 1. The development config resolves normally, but the same async config function rejects for production.
  /// 2. The config is repaired and another production build is requested on the same builder.
  /// @expect
  /// The first production build reports the config error, closes its one-shot config loader, and the next build succeeds from the repaired config.
  const project = await makeTempDir();
  const failedBuildDir = join(await makeTempDir(), 'failed-build');
  const recoveredBuildDir = join(await makeTempDir(), 'recovered-build');
  const configPath = join(project, 'oms.config.mjs');
  await fs.outputFile(configPath, [
    'export default async ({ mode }) => {',
    '  if (mode === "production") {',
    '    throw new Error("production-config-reject-marker");',
    '  }',
    '  return {};',
    '};',
  ].join('\n'));
  await fs.outputFile(join(project, 'src', 'index.ts'), 'export const configRecoveryMarker = "config-recovery-marker";');
  const ctx = new ServerContext({
    invoke: async () => undefined,
  } as any);
  const builder = new OmsBuilder(ctx, {
    project,
  });
  const closeWatcher = vi.spyOn(OmsProjectConfigWatcher.prototype, 'close');

  try {
    await expect(rebuildDefault(builder, { extensionBuildOptions: [] })).resolves.toMatchObject({ ok: true });
    await expect(builder.buildProd({
      buildDir: failedBuildDir,
      debug: true,
      sourceMaps: false,
      platform: 'web',
      headless: false,
    })).rejects.toThrow('production-config-reject-marker');
    expect(closeWatcher).toHaveBeenCalledTimes(1);

    const repairedDevelopmentBuild = waitForPassiveBuildEnd(builder);
    await fs.outputFile(configPath, 'export default async () => ({});');
    await expect(repairedDevelopmentBuild).resolves.toMatchObject({
      profileResults: {
        default: { ok: true },
        headless: { ok: true },
      },
    });
    await expect(builder.buildProd({
      buildDir: recoveredBuildDir,
      debug: true,
      sourceMaps: false,
      platform: 'web',
      headless: false,
    })).resolves.toBeUndefined();
    expect(closeWatcher).toHaveBeenCalledTimes(2);
    expect(await readJavaScriptOutput(join(recoveredBuildDir, 'oms'))).toContain('config-recovery-marker');
  } finally {
    try {
      await (builder as any)._clean();
    } finally {
      closeWatcher.mockRestore();
    }
  }
});

it('reuses development UUIDs in Debug and Release production builds without rewriting the UUID map', async () => {
  /// @case
  /// 1. Development discovers a component without an inline UUID and persists its generated project UUID.
  /// 2. The same project is built as Debug and Release production output.
  /// @expect
  /// Every output registers the component with the same UUID, and neither production build changes the persisted UUID map.
  const project = await makeTempDir();
  const debugBuildDir = join(await makeTempDir(), 'debug-build');
  const releaseBuildDir = join(await makeTempDir(), 'release-build');
  await fs.outputFile(join(project, 'src', 'index.ts'), 'export const main = true;');
  await fs.outputFile(join(project, 'src', 'shared.component.ts'), [
    'import { _decorator, Component } from "cc";',
    'const { ccclass } = _decorator;',
    '@ccclass("SharedComponent")',
    'export class SharedComponent extends Component {}',
  ].join('\n'));
  const ctx = new ServerContext({
    invoke: async () => undefined,
  } as any);
  const builder = new OmsBuilder(ctx, {
    project,
  });

  try {
    await expect(rebuildDefault(builder, { extensionBuildOptions: [] })).resolves.toMatchObject({ ok: true });
    const uuidMapPath = join(project, 'temp', 'oms', 'uuids.json');
    const uuidMapBeforeProduction = await fs.readFile(uuidMapPath, 'utf8');
    const developmentOutput = await readJavaScriptOutput(join(project, 'temp', 'oms', 'out'));

    await builder.buildProd({
      buildDir: debugBuildDir,
      debug: true,
      sourceMaps: false,
      platform: 'web',
      headless: false,
    });
    expect(await fs.readFile(uuidMapPath, 'utf8')).toBe(uuidMapBeforeProduction);

    await builder.buildProd({
      buildDir: releaseBuildDir,
      debug: false,
      sourceMaps: false,
      platform: 'web',
      headless: false,
    });
    expect(await fs.readFile(uuidMapPath, 'utf8')).toBe(uuidMapBeforeProduction);

    const debugOutput = await readJavaScriptOutput(join(debugBuildDir, 'oms'));
    const releaseOutput = await readJavaScriptOutput(join(releaseBuildDir, 'oms'));
    const registrationPattern = /_RF\.push\(\{\},\s*["']([^"']+)["'],\s*["']shared\.component\.ts["']/;
    const developmentRegistration = registrationPattern.exec(developmentOutput)?.[1];
    expect(developmentRegistration).toBeTruthy();
    expect(registrationPattern.exec(debugOutput)?.[1]).toBe(developmentRegistration);
    expect(registrationPattern.exec(releaseOutput)?.[1]).toBe(developmentRegistration);
  } finally {
    await (builder as any)._clean();
  }
});

it('resolves a linked extension component UUID through its real path in production', async () => {
  /// @case
  /// 1. Development discovers a component through a junction-backed extension path and generates its project UUID.
  /// 2. Production rescans the linked extension while UUID access is read-only.
  /// @expect
  /// Both path spellings resolve to the same UUID record, production succeeds with the development UUID, and the UUID map is unchanged.
  const project = await makeTempDir();
  const buildDir = join(await makeTempDir(), 'build');
  const realExtensionRoot = join(await makeTempDir(), 'linked-extension-target');
  const linkedExtensionRoot = join(project, 'extensions', 'linked-extension');
  await fs.outputFile(join(project, 'src', 'index.ts'), 'export const main = true;');
  await fs.outputJSON(join(realExtensionRoot, 'package.json'), {
    oms: {
      partitions: [{ rootDir: 'oms/src' }],
    },
  });
  await fs.outputFile(join(realExtensionRoot, 'oms', 'src', 'linked.component.ts'), [
    'import { _decorator, Component } from "cc";',
    'const { ccclass } = _decorator;',
    '@ccclass("LinkedComponent")',
    'export class LinkedComponent extends Component {}',
  ].join('\n'));
  await fs.ensureDir(join(project, 'extensions'));
  await fs.ensureSymlink(realExtensionRoot, linkedExtensionRoot, process.platform === 'win32' ? 'junction' : 'dir');
  const extensionBuildOptions = [{ name: 'linked-extension', path: linkedExtensionRoot }];
  const ctx = new ServerContext({
    invoke: async () => undefined,
  } as any);
  const builder = new OmsBuilder(ctx, {
    project,
  });

  try {
    await expect(rebuildDefault(builder, { extensionBuildOptions })).resolves.toMatchObject({ ok: true });
    const uuidMapPath = join(project, 'temp', 'oms', 'uuids.json');
    const uuidMapBeforeProduction = await fs.readFile(uuidMapPath, 'utf8');
    const developmentOutput = await readJavaScriptOutput(join(project, 'temp', 'oms', 'out'));

    await expect(builder.buildProd({
      buildDir,
      debug: true,
      sourceMaps: false,
      platform: 'web',
      headless: false,
    })).resolves.toBeUndefined();

    expect(await fs.readFile(uuidMapPath, 'utf8')).toBe(uuidMapBeforeProduction);
    const productionOutput = await readJavaScriptOutput(join(buildDir, 'oms'));
    const registrationPattern = /_RF\.push\(\{\},\s*["']([^"']+)["'],\s*["']linked\.component\.ts["']/;
    const developmentRegistration = registrationPattern.exec(developmentOutput)?.[1];
    expect(developmentRegistration).toBeTruthy();
    expect(registrationPattern.exec(productionOutput)?.[1]).toBe(developmentRegistration);
  } finally {
    await (builder as any)._clean();
  }
});

it('reads a production-only component UUID without changing the project UUID map', async () => {
  /// @case
  /// 1. A mode-dependent domain uses a production-only source partition.
  /// 2. The production-only component already has a centralized project UUID.
  /// @expect
  /// Production registers the component from the existing UUID and leaves the emitted project UUID map byte-for-byte unchanged.
  const project = await makeTempDir();
  const buildDir = join(await makeTempDir(), 'build');
  const productionComponent = join(project, 'prod-src', 'production-only.component.ts');
  await fs.outputFile(join(project, 'oms.config.mjs'), [
    'export default ({ mode }) => ({',
    '  partitions: [{ rootDir: mode === "production" ? "prod-src" : "src" }],',
    '});',
  ].join('\n'));
  await fs.outputFile(join(project, 'src', 'index.ts'), 'export const developmentEntry = true;');
  await fs.outputFile(productionComponent, [
    'import { _decorator, Component } from "cc";',
    'const { ccclass } = _decorator;',
    '@ccclass("ProductionOnlyComponent")',
    'export class ProductionOnlyComponent extends Component {}',
  ].join('\n'));
  await fs.outputJSON(join(project, 'oms', 'uuids.json'), {
    'prod-src/production-only.component.ts': '12121212-1212-4121-8121-121212121212',
  }, { spaces: 2 });
  const ctx = new ServerContext({
    invoke: async () => undefined,
  } as any);
  const builder = new OmsBuilder(ctx, {
    project,
  });

  try {
    await expect(rebuildDefault(builder, { extensionBuildOptions: [] })).resolves.toMatchObject({ ok: true });
    const uuidMapPath = join(project, 'temp', 'oms', 'uuids.json');
    const uuidMapBeforeProduction = await fs.readFile(uuidMapPath, 'utf8');

    await expect(builder.buildProd({
      buildDir,
      debug: true,
      sourceMaps: false,
      platform: 'web',
      headless: false,
    })).resolves.toBeUndefined();

    expect(await fs.readFile(uuidMapPath, 'utf8')).toBe(uuidMapBeforeProduction);
    const productionOutput = await readJavaScriptOutput(join(buildDir, 'oms'));
    expect(productionOutput).toMatch(/_RF\.push\(\{\},\s*["'][^"']+["'],\s*["']production-only\.component\.ts["']/);
  } finally {
    await (builder as any)._clean();
  }
});

it('fails production when a production-only component has no project UUID', async () => {
  /// @case
  /// 1. Development initializes a project UUID map from its own source partition.
  /// 2. Production switches to a partition containing a component that development never discovered and that has no centralized UUID.
  /// @expect
  /// Production fails with the missing component path and does not generate or persist a UUID.
  const project = await makeTempDir();
  const buildDir = join(await makeTempDir(), 'build');
  const productionComponent = join(project, 'prod-src', 'missing.component.ts');
  await fs.outputFile(join(project, 'oms.config.mjs'), [
    'export default ({ mode }) => ({',
    '  partitions: [{ rootDir: mode === "production" ? "prod-src" : "src" }],',
    '});',
  ].join('\n'));
  await fs.outputFile(join(project, 'src', 'development.component.ts'), [
    '/// <meta "uuid"="34343434-3434-4343-8343-343434343434"/>',
    'export class DevelopmentComponent {}',
  ].join('\n'));
  await fs.outputFile(productionComponent, 'export class MissingProductionComponent {}');
  const ctx = new ServerContext({
    invoke: async () => undefined,
  } as any);
  const builder = new OmsBuilder(ctx, {
    project,
  });

  try {
    await expect(rebuildDefault(builder, { extensionBuildOptions: [] })).resolves.toMatchObject({ ok: true });
    const uuidMapPath = join(project, 'temp', 'oms', 'uuids.json');
    const uuidMapBeforeProduction = await fs.readFile(uuidMapPath, 'utf8');

    await expect(builder.buildProd({
      buildDir,
      debug: true,
      sourceMaps: false,
      platform: 'web',
      headless: false,
    })).rejects.toThrow(/Production component .*missing\.component\.ts has no project UUID/);

    expect(await fs.readFile(uuidMapPath, 'utf8')).toBe(uuidMapBeforeProduction);
    const emittedUUIDs = await fs.readJSON(uuidMapPath) as Record<string, string>;
    expect(Object.keys(emittedUUIDs).some((file) => file.endsWith('missing.component.ts'))).toBe(false);
  } finally {
    await (builder as any)._clean();
  }
});

it('does not require a UUID for a production-only editor component that cannot enter runtime output', async () => {
  /// @case
  /// 1. Development initializes the project UUID manager from a development source partition.
  /// 2. Production switches to a partition containing a runtime entry and an editor-suffixed component that has never received a UUID.
  /// @expect
  /// Production omits the editor component without requesting or writing a UUID, while the runtime entry still builds normally.
  const project = await makeTempDir();
  const buildDir = join(await makeTempDir(), 'build');
  await fs.outputFile(join(project, 'oms.config.mjs'), [
    'export default ({ mode }) => ({',
    '  partitions: [{ rootDir: mode === "production" ? "prod-src" : "src" }],',
    '});',
  ].join('\n'));
  await fs.outputFile(join(project, 'src', 'development.component.ts'), [
    '/// <meta "uuid"="56565656-5656-4565-8565-565656565656"/>',
    'export class DevelopmentComponent {}',
  ].join('\n'));
  await fs.outputFile(join(project, 'prod-src', 'index.ts'), 'export const productionRuntimeMarker = "production-runtime-marker";');
  await fs.outputFile(join(project, 'prod-src', 'unused.component.editor.ts'), 'globalThis.__omsUnusedEditorComponent = "unused-editor-component-marker";');
  const ctx = new ServerContext({
    invoke: async () => undefined,
  } as any);
  const builder = new OmsBuilder(ctx, {
    project,
  });

  try {
    await expect(rebuildDefault(builder, { extensionBuildOptions: [] })).resolves.toMatchObject({ ok: true });
    const uuidMapPath = join(project, 'temp', 'oms', 'uuids.json');
    const uuidMapBeforeProduction = await fs.readFile(uuidMapPath, 'utf8');

    await expect(builder.buildProd({
      buildDir,
      debug: true,
      sourceMaps: false,
      platform: 'web',
      headless: false,
    })).resolves.toBeUndefined();

    expect(await fs.readFile(uuidMapPath, 'utf8')).toBe(uuidMapBeforeProduction);
    const productionOutput = await readJavaScriptOutput(join(buildDir, 'oms'));
    expect(productionOutput).toContain('production-runtime-marker');
    expect(productionOutput).not.toContain('unused-editor-component-marker');
  } finally {
    await (builder as any)._clean();
  }
});

it('minifies release output with preserved names and composed source maps', async () => {
  /// @case
  /// 1. The same project is built as Debug and Release with a runtime-observable class name.
  /// 2. Release builds request disabled, external, and inline source maps.
  /// @expect
  /// Only Release is minified, class names remain observable, SystemJS chunks keep isolated helper scopes, emitted JavaScript stays valid, and every source-map mode is honored.
  const project = await makeTempDir();
  const debugBuildDir = join(await makeTempDir(), 'debug-build');
  const releaseBuildDir = join(await makeTempDir(), 'release-build');
  const externalMapBuildDir = join(await makeTempDir(), 'external-map-build');
  const inlineMapBuildDir = join(await makeTempDir(), 'inline-map-build');
  const headlessDebugBuildDir = join(await makeTempDir(), 'headless-debug-build');
  const headlessReleaseBuildDir = join(await makeTempDir(), 'headless-release-build');
  await fs.outputFile(join(project, 'oms.config.mjs'), [
    'export default {',
    '  profiles: { headless: { include: ["src/**"] } },',
    '};',
  ].join('\n'));
  await fs.outputFile(join(project, 'src', 'index.ts'), [
    '/*! @license OMS_RELEASE_MINIFY_TEST */',
    'export class PreservedRuntimeName {',
    '  static read() {',
    '    const deliberatelyLongRuntimeValue = "release-minify-marker";',
    '    return deliberatelyLongRuntimeValue + deliberatelyLongRuntimeValue;',
    '  }',
    '}',
    'globalThis.__omsPreservedRuntimeName = PreservedRuntimeName.name;',
    'globalThis.__omsMinifyValue = PreservedRuntimeName.read();',
  ].join('\n'));
  await fs.outputFile(join(project, 'src', 'index.headless.ts'), 'export * from "./index.js";');
  const ctx = new ServerContext({
    invoke: async () => undefined,
  } as any);
  const builder = new OmsBuilder(ctx, {
    project,
  });

  try {
    await expect(rebuildDefault(builder, { extensionBuildOptions: [] })).resolves.toMatchObject({ ok: true });
    await builder.buildProd({
      buildDir: debugBuildDir,
      debug: true,
      sourceMaps: false,
      platform: 'web',
      headless: false,
    });
    await builder.buildProd({
      buildDir: releaseBuildDir,
      debug: false,
      sourceMaps: false,
      platform: 'web',
      headless: false,
    });
    await builder.buildProd({
      buildDir: externalMapBuildDir,
      debug: false,
      sourceMaps: true,
      platform: 'web',
      headless: false,
    });
    await builder.buildProd({
      buildDir: inlineMapBuildDir,
      debug: false,
      sourceMaps: 'inline',
      platform: 'web',
      headless: false,
    });
    await builder.buildProd({
      buildDir: headlessDebugBuildDir,
      debug: true,
      sourceMaps: false,
      platform: 'nodejs',
      headless: true,
    });
    await builder.buildProd({
      buildDir: headlessReleaseBuildDir,
      debug: false,
      sourceMaps: false,
      platform: 'nodejs',
      headless: true,
    });

    const debugOutput = await fs.readFile(join(debugBuildDir, 'oms', 'bundle-main.js'), 'utf8');
    const releaseOutput = await fs.readFile(join(releaseBuildDir, 'oms', 'bundle-main.js'), 'utf8');
    const releaseSystemFiles = await readJavaScriptFiles(join(releaseBuildDir, 'oms'));
    expect(Buffer.byteLength(releaseOutput)).toBeLessThan(Buffer.byteLength(debugOutput));
    expect(releaseOutput).toContain('PreservedRuntimeName');
    expect(releaseOutput).toContain('release-minify-marker');
    expect(releaseOutput).toContain('@license OMS_RELEASE_MINIFY_TEST');
    expect(() => new Function(releaseOutput)).not.toThrow();
    expect(releaseSystemFiles.length).toBeGreaterThan(1);
    for (const { source } of releaseSystemFiles) {
      expect(source.trimStart()).toMatch(/^\(\(\)=>\{/);
    }
    await expect(fs.pathExists(join(releaseBuildDir, 'oms', 'bundle-main.js.map'))).resolves.toBe(false);

    const externalMapPath = join(externalMapBuildDir, 'oms', 'bundle-main.js.map');
    await expect(fs.pathExists(externalMapPath)).resolves.toBe(true);
    const externalMap = JSON.parse(await fs.readFile(externalMapPath, 'utf8')) as {
      mappings: string;
      sources: string[];
      sourcesContent: Array<string | null>;
    };
    expect(externalMap.mappings).not.toBe('');
    const originalSourceIndex = externalMap.sources.findIndex((source) => source.replace(/\\/g, '/').endsWith('/src/index.ts'));
    expect(originalSourceIndex).toBeGreaterThanOrEqual(0);
    expect(externalMap.sourcesContent[originalSourceIndex]).toContain('const deliberatelyLongRuntimeValue = "release-minify-marker";');
    const externalMapOutput = await fs.readFile(join(externalMapBuildDir, 'oms', 'bundle-main.js'), 'utf8');
    expect(externalMapOutput).toContain('sourceMappingURL=bundle-main.js.map');
    const generatedMarkerPosition = getGeneratedPosition(externalMapOutput, 'release-minify-marker');
    const tracedMarkerPosition = originalPositionFor(new TraceMap(externalMap), generatedMarkerPosition);
    expect(tracedMarkerPosition.source?.replace(/\\/g, '/')).toMatch(/\/src\/index\.ts$/);
    expect(tracedMarkerPosition.line).toBe(4);

    const inlineMapOutput = await fs.readFile(join(inlineMapBuildDir, 'oms', 'bundle-main.js'), 'utf8');
    expect(inlineMapOutput).toContain('sourceMappingURL=data:application/json');
    const inlineMapMatch = /sourceMappingURL=data:application\/json[^,]*;base64,([^\s]+)/.exec(inlineMapOutput);
    expect(inlineMapMatch).toBeTruthy();
    const inlineMap = JSON.parse(Buffer.from(inlineMapMatch![1], 'base64').toString('utf8')) as {
      mappings: string;
      sources: string[];
      sourcesContent: Array<string | null>;
    };
    expect(inlineMap.mappings).not.toBe('');
    expect(inlineMap.sources.some((source) => source.replace(/\\/g, '/').endsWith('/src/index.ts'))).toBe(true);
    await expect(fs.pathExists(join(inlineMapBuildDir, 'oms', 'bundle-main.js.map'))).resolves.toBe(false);

    const headlessDebugOutput = await readJavaScriptOutput(join(headlessDebugBuildDir, 'oms'));
    const headlessReleaseOutput = await readJavaScriptOutput(join(headlessReleaseBuildDir, 'oms'));
    expect(Buffer.byteLength(headlessReleaseOutput)).toBeLessThan(Buffer.byteLength(headlessDebugOutput));
    expect(headlessReleaseOutput).toContain('PreservedRuntimeName');
    expect(headlessReleaseOutput).toContain('release-minify-marker');
    expect(headlessReleaseOutput).toContain('@license OMS_RELEASE_MINIFY_TEST');
    expect(headlessReleaseOutput.trimStart()).not.toMatch(/^\(\(\)=>\{/);
    const headlessRuntimeModule = (await readJavaScriptFiles(join(headlessReleaseBuildDir, 'oms')))
      .find(({ source }) => source.includes('release-minify-marker'));
    expect(headlessRuntimeModule).toBeTruthy();
    delete (globalThis as Record<string, unknown>).__omsPreservedRuntimeName;
    await import(/* @vite-ignore */ `${pathToFileURL(headlessRuntimeModule!.path).href}?oms-test=${Date.now()}`);
    expect((globalThis as Record<string, unknown>).__omsPreservedRuntimeName).toBe('PreservedRuntimeName');
  } finally {
    delete (globalThis as Record<string, unknown>).__omsPreservedRuntimeName;
    delete (globalThis as Record<string, unknown>).__omsMinifyValue;
    await (builder as any)._clean();
  }
});

it('replaces process.env.NODE_ENV in production dependencies', async () => {
  /// @case
  /// 1. A production build imports a dependency that branches on process.env.NODE_ENV.
  /// 2. The project does not explicitly define process.env.NODE_ENV.
  /// @expect
  /// OMS applies the default production NODE_ENV define, so browser output does not retain a process reference.
  const project = await makeTempDir();
  const buildDir = join(await makeTempDir(), 'build');
  await fs.ensureDir(join(project, 'src'));
  await fs.ensureDir(join(project, 'node_modules', 'tiny-node-env'));
  await fs.outputJSON(join(project, 'node_modules', 'tiny-node-env', 'package.json'), {
    name: 'tiny-node-env',
    version: '1.0.0',
    type: 'module',
    exports: './index.js',
  });
  await fs.outputFile(join(project, 'node_modules', 'tiny-node-env', 'index.js'), [
    'export const value = process.env.NODE_ENV === "production" ? "prod-branch" : "dev-branch";',
  ].join('\n'));
  await fs.outputFile(join(project, 'src', 'index.ts'), [
    'import { value } from "tiny-node-env";',
    'export const result = value;',
  ].join('\n'));
  const ctx = new ServerContext({
    invoke: async () => undefined,
  } as any);
  const builder = new OmsBuilder(ctx, {
    project,
  });

  try {
    await expect(rebuildDefault(builder, {
      extensionBuildOptions: [],
    })).resolves.toMatchObject({
      ok: true,
    });
    await builder.buildProd({
      buildDir,
      debug: false,
      sourceMaps: false,
      platform: 'web',
      headless: false,
    });

    const output = await fs.readFile(join(buildDir, 'oms', 'bundle-main.js'), 'utf8');
    expect(output).toContain('prod-branch');
    expect(output).not.toContain('dev-branch');
    expect(output).not.toContain('process.env.NODE_ENV');
    expect(output).not.toContain('process');
  } finally {
    await (builder as any)._clean();
  }
});
it('rebuilds when a dotenv file changes', async () => {
  /// @case
  /// 1. A project entry reads import.meta.env.OMS_VALUE from .env.
  /// 2. The .env file changes after the initial build.
  /// @expect
  /// The existing OMS watcher treats .env as a build dependency and emits a passive rebuild with the updated value.
  const project = await makeTempDir();
  await fs.ensureDir(join(project, 'src'));
  await fs.outputFile(join(project, '.env'), 'OMS_VALUE=one\n');
  await fs.outputFile(join(project, 'src', 'index.ts'), [
    'export const value = import.meta.env.OMS_VALUE;',
  ].join('\n'));
  const ctx = new ServerContext({
    invoke: async () => undefined,
  } as any);
  const builder = new OmsBuilder(ctx, {
    project,
  });

  try {
    await expect(rebuildDefault(builder, {
      extensionBuildOptions: [],
    })).resolves.toMatchObject({
      ok: true,
    });
    await expect(fs.readFile(join(project, 'temp', 'oms', 'out', 'bundle-main.js'), 'utf8')).resolves.toContain('one');

    const passiveBuildEnd = waitForPassiveBuildEnd(builder);
    await fs.outputFile(join(project, '.env'), 'OMS_VALUE=two\n');

    await expect(passiveBuildEnd).resolves.toMatchObject({
      profileResults: {
        default: { ok: true },
        headless: { ok: true },
      },
    });
    const output = await fs.readFile(join(project, 'temp', 'oms', 'out', 'bundle-main.js'), 'utf8');
    expect(output).toContain('two');
    expect(output).not.toContain('one');
  } finally {
    await (builder as any)._clean();
  }
});

it('keeps a source file when it is recreated before the passive rebuild runs', async () => {
  /// @case
  /// 1. A component source file participates in the initial OMS build.
  /// 2. The file is deleted and recreated at the same path before the passive rebuild runs.
  /// @expect
  /// The passive rebuild treats the final file state as present and keeps the recreated source in the bundle.
  const project = await makeTempDir();
  const component = join(project, 'src', 'recreated.component.ts');
  await fs.ensureDir(join(project, 'src'));
  await fs.outputFile(component, [
    '(globalThis as any).__omsRecreatedMarker = "before-recreate-marker";',
    '',
  ].join('\n'));
  const ctx = new ServerContext({
    invoke: async () => undefined,
  } as any);
  const builder = new OmsBuilder(ctx, {
    project,
  });

  try {
    await expect(rebuildDefault(builder, {
      extensionBuildOptions: [],
    })).resolves.toMatchObject({
      ok: true,
    });
    await expect(fs.readFile(join(project, 'temp', 'oms', 'out', 'bundle-main.js'), 'utf8')).resolves.toContain('before-recreate-marker');

    const passiveBuildEnd = waitForPassiveBuildEnd(builder);
    await fs.remove(component);
    await setTimeout(20);
    await fs.outputFile(component, [
      '(globalThis as any).__omsRecreatedMarker = "after-recreate-marker";',
      '',
    ].join('\n'));

    await expect(passiveBuildEnd).resolves.toMatchObject({
      profileResults: {
        default: { ok: true },
        headless: { ok: true },
      },
    });
    const output = await fs.readFile(join(project, 'temp', 'oms', 'out', 'bundle-main.js'), 'utf8');
    expect(output).toContain('after-recreate-marker');
    expect(output).not.toContain('before-recreate-marker');
  } finally {
    await (builder as any)._clean();
  }
});

it('returns runtime build success without waiting for a failing headless profile', async () => {
  /// @case
  /// 1. A project enables headless output with a valid runtime entry and a broken headless-only entry.
  /// 2. The startup build requests runtime readiness without waiting for headless.
  /// @expect
  /// The build returns success for runtime output, and scene metadata does not include the headless entry.
  const project = await makeTempDir();
  await fs.outputFile(join(project, 'oms.config.mjs'), [
    'export default {',
    '  profiles: {',
    '    headless: {',
    '      include: ["src/**/*.headless.ts"],',
    '    },',
    '  },',
    '};',
  ].join('\n'));
  await fs.outputFile(join(project, 'src', 'index.ts'), 'export const runtimeMarker = "runtime-ready";');
  await fs.outputFile(join(project, 'src', 'index.headless.ts'), 'import "./missing-headless-only";');
  const buildEnd = deferred<void>();
  const ctx = new ServerContext({
    invoke: async (method: string) => {
      if (method === 'build-end') {
        buildEnd.resolve();
      }
    },
  } as any);
  const builder = new OmsBuilder(ctx, {
    project,
  });

  try {
    await expect(rebuildDefault(builder, {
      extensionBuildOptions: [],
      profiles: ['default'],
    })).resolves.toMatchObject({
      ok: true,
    });

    const runtimeOutput = await fs.readFile(join(project, 'temp', 'oms', 'out', 'bundle-main.js'), 'utf8');
    const metadataOutput = await fs.readFile(join(project, 'temp', 'oms', 'out', 'metadata.js'), 'utf8');
    expect(runtimeOutput).toContain('runtime-ready');
    expect(metadataOutput).not.toContain('main.headless');
    await buildEnd.promise;
  } finally {
    await (builder as any)._clean();
  }
});

it('keeps full rebuild failure semantics for a failing headless profile', async () => {
  /// @case
  /// 1. A project enables headless output with a valid runtime entry and a broken headless-only entry.
  /// 2. A normal rebuild waits for all profiles.
  /// @expect
  /// The build fails and reports the headless profile error.
  const project = await makeTempDir();
  await fs.outputFile(join(project, 'oms.config.mjs'), [
    'export default {',
    '  profiles: {',
    '    headless: {',
    '      include: ["src/**/*.headless.ts"],',
    '    },',
    '  },',
    '};',
  ].join('\n'));
  await fs.outputFile(join(project, 'src', 'index.ts'), 'export const runtimeMarker = "runtime-ready";');
  await fs.outputFile(join(project, 'src', 'index.headless.ts'), 'import "./missing-headless-only";');
  const ctx = new ServerContext({
    invoke: async () => undefined,
  } as any);
  const builder = new OmsBuilder(ctx, {
    project,
  });

  try {
    await expect(rebuildProfiles(builder, {
      extensionBuildOptions: [],
    })).resolves.toMatchObject({
      default: {
        ok: true,
      },
      headless: {
        ok: false,
        error: {
          message: expect.stringContaining('headless-build failed'),
        },
      },
    });
  } finally {
    await (builder as any)._clean();
  }
});

it('reports per-profile passive results when headless fails', async () => {
  /// @case
  /// 1. A project has a valid default entry and a broken headless-only entry.
  /// 2. A source change triggers a passive full revision.
  /// @expect
  /// The revision reports each profile independently so runtime side effects can use the successful default result.
  const project = await makeTempDir();
  const runtimeEntry = join(project, 'src', 'index.ts');
  await fs.outputFile(join(project, 'oms.config.mjs'), [
    'export default {',
    '  profiles: {',
    '    headless: {',
    '      include: ["src/**/*.headless.ts"],',
    '    },',
    '  },',
    '};',
  ].join('\n'));
  await fs.outputFile(runtimeEntry, 'export const marker = "before-passive-profile-result";');
  await fs.outputFile(join(project, 'src', 'index.headless.ts'), 'import "./missing-passive-headless";');
  const initialBuildEnd = deferred<void>();
  let buildEndCount = 0;
  const ctx = new ServerContext({
    invoke: async (method: string) => {
      if (method === 'build-end' && ++buildEndCount === 1) {
        initialBuildEnd.resolve();
      }
    },
  } as any);
  const builder = new OmsBuilder(ctx, { project });

  try {
    await expect(rebuildDefault(builder, {
      extensionBuildOptions: [],
      profiles: ['default'],
    })).resolves.toMatchObject({ ok: true });
    await initialBuildEnd.promise;

    const passiveBuildEnd = waitForPassiveBuildEnd(builder);
    await fs.outputFile(runtimeEntry, 'export const marker = "after-passive-profile-result";');

    await expect(passiveBuildEnd).resolves.toMatchObject({
      profileResults: {
        default: {
          ok: true,
        },
        headless: {
          ok: false,
        },
      },
    });
  } finally {
    await builder.close();
  }
});

it('keeps watching the last successful headless dependencies after a later headless failure', async () => {
  /// @case
  /// 1. A runtime-only build returns before the headless profile finishes.
  /// 2. The headless profile infers a dependency outside the OMS source root.
  /// 3. A later headless build fails, then that last successful dependency changes again.
  /// @expect
  /// The inferred dependency remains passively watched across the failure and triggers the next passive build.
  const project = await makeTempDir();
  await fs.outputFile(join(project, 'oms.config.mjs'), [
    'export default {',
    '  profiles: {',
    '    headless: {',
    '      include: ["src/**/*.headless.ts"],',
    '    },',
    '  },',
    '};',
  ].join('\n'));
  await fs.outputFile(join(project, 'src', 'index.ts'), 'export const runtimeMarker = "runtime-ready";');
  await fs.outputFile(join(project, 'src', 'index.headless.ts'), [
    'import { headlessValue } from "../shared/headless-dep";',
    'export const value = headlessValue;',
  ].join('\n'));
  await fs.outputFile(join(project, 'shared', 'headless-dep.ts'), 'export const headlessValue = "before";');
  const buildEnd = deferred<void>();
  const ctx = new ServerContext({
    invoke: async (method: string) => {
      if (method === 'build-end') {
        buildEnd.resolve();
      }
    },
  } as any);
  const builder = new OmsBuilder(ctx, {
    project,
  });

  try {
    await expect(rebuildDefault(builder, {
      extensionBuildOptions: [],
      profiles: ['default'],
    })).resolves.toMatchObject({
      ok: true,
    });
    await buildEnd.promise;

    const passiveBuildEnd = waitForPassiveBuildEnd(builder);
    await fs.outputFile(join(project, 'shared', 'headless-dep.ts'), 'export const headlessValue = "after";');

    await expect(passiveBuildEnd).resolves.toMatchObject({
      profileResults: {
        default: { ok: true },
        headless: { ok: true },
      },
    });

    const failedHeadlessBuildEnd = waitForPassiveBuildEnd(builder);
    await fs.outputFile(join(project, 'src', 'index.headless.ts'), 'import "./missing-after-success";');
    await expect(failedHeadlessBuildEnd).resolves.toMatchObject({
      profileResults: {
        default: { ok: true },
        headless: {
          ok: false,
          error: {
            message: expect.stringContaining('headless-build failed'),
          },
        },
      },
    });

    const retainedDependencyBuildEnd = waitForPassiveBuildEnd(builder);
    await fs.outputFile(join(project, 'shared', 'headless-dep.ts'), 'export const headlessValue = "after-failure";');
    await expect(retainedDependencyBuildEnd).resolves.toMatchObject({
      profileResults: {
        default: { ok: true },
        headless: { ok: false },
      },
    });
  } finally {
    await (builder as any)._clean();
  }
});

it('queues source changes behind the active profile revision barrier', async () => {
  /// @case
  /// 1. The initial default profile becomes ready while a deliberately large headless dependency is still building.
  /// 2. A default source changes before that headless lane finishes.
  /// @expect
  /// The source change runs in one following revision after the initial barrier.
  const project = await makeTempDir();
  const runtimeEntry = join(project, 'src', 'index.ts');
  await fs.outputFile(join(project, 'oms.config.mjs'), [
    'export default {',
    '  profiles: {',
    '    headless: {',
    '      include: ["src/**/*.headless.ts"],',
    '    },',
    '  },',
    '};',
  ].join('\n'));
  await fs.outputFile(runtimeEntry, 'export const marker = "before-shared-barrier";');
  await fs.outputFile(join(project, 'src', 'index.headless.ts'), 'export { values } from "../headless-heavy";');
  await fs.outputFile(join(project, 'headless-heavy.ts'), [
    'export const values = [',
    Array.from({ length: 50_000 }, (_, index) => `${index},`).join(''),
    '];',
  ].join('\n'));
  const buildEvents: string[] = [];
  const ctx = new ServerContext({
    invoke: async (method: string) => {
      if (method === 'build-start') {
        buildEvents.push('start');
      } else if (method === 'build-end') {
        buildEvents.push('end');
      }
    },
  } as any);
  const builder = new OmsBuilder(ctx, {
    project,
  });

  try {
    await expect(rebuildDefault(builder, {
      extensionBuildOptions: [],
      profiles: ['default'],
    })).resolves.toMatchObject({ ok: true });
    expect(buildEvents).toEqual(['start']);

    const passiveBuildEnd = waitForPassiveBuildEnd(builder);
    await fs.outputFile(runtimeEntry, 'export const marker = "after-shared-barrier";');

    await expect(passiveBuildEnd).resolves.toMatchObject({
      profileResults: {
        default: { ok: true },
        headless: { ok: true },
      },
    });
    expect(buildEvents).toEqual(['start', 'end', 'start', 'end']);
    const output = await fs.readFile(join(project, 'temp', 'oms', 'out', 'bundle-main.js'), 'utf8');
    expect(output).toContain('after-shared-barrier');
    expect(output).not.toContain('before-shared-barrier');
  } finally {
    await builder.close();
  }
});

it('coalesces concurrent callers waiting for the same profile', async () => {
  /// @case
  /// 1. Two callers request the default profile before the first request completes.
  /// 2. Both callers target the same source revision.
  /// @expect
  /// Both callers share one default-profile build instead of rebuilding the watcher twice.
  const project = await makeTempDir();
  await fs.outputFile(join(project, 'src', 'index.ts'), 'export const marker = "shared-default-build";');
  let buildStartCount = 0;
  const ctx = new ServerContext({
    invoke: async (method: string) => {
      if (method === 'build-start') {
        buildStartCount++;
      }
    },
  } as any);
  const builder = new OmsBuilder(ctx, {
    project,
  });

  try {
    const firstBuild = rebuildDefault(builder, {
      extensionBuildOptions: [],
      profiles: ['default'],
    });
    const secondBuild = rebuildDefault(builder, {
      extensionBuildOptions: [],
      profiles: ['default'],
    });

    await expect(Promise.all([firstBuild, secondBuild])).resolves.toEqual([
      expect.objectContaining({ ok: true }),
      expect.objectContaining({ ok: true }),
    ]);
    expect(buildStartCount).toBe(1);
  } finally {
    await builder.close();
  }
});

it('runs concurrent default and headless callers in one build revision', async () => {
  /// @case
  /// 1. A project has a valid default entry and a broken headless-only entry.
  /// 2. Separate callers request default and headless while the initial revision is starting.
  /// @expect
  /// Both profile lanes share one revision, while each caller receives only its requested profile result.
  const project = await makeTempDir();
  await fs.outputFile(join(project, 'oms.config.mjs'), [
    'export default {',
    '  profiles: {',
    '    headless: {',
    '      include: ["src/**/*.headless.ts"],',
    '    },',
    '  },',
    '};',
  ].join('\n'));
  await fs.outputFile(join(project, 'src', 'index.ts'), 'export const marker = "default-ready";');
  await fs.outputFile(join(project, 'src', 'index.headless.ts'), 'import "./missing-headless-entry";');
  let buildStartCount = 0;
  const ctx = new ServerContext({
    invoke: async (method: string) => {
      if (method === 'build-start') {
        buildStartCount++;
      }
    },
  } as any);
  const builder = new OmsBuilder(ctx, {
    project,
  });

  try {
    const defaultBuild = rebuildProfiles(builder, {
      extensionBuildOptions: [],
      profiles: ['default'],
    });
    const headlessBuild = rebuildProfiles(builder, {
      extensionBuildOptions: [],
      profiles: ['headless'],
    });

    await expect(defaultBuild).resolves.toMatchObject({
      default: { ok: true },
    });
    await expect(headlessBuild).resolves.toMatchObject({
      headless: {
        ok: false,
        error: {
          message: expect.stringContaining('headless-build failed'),
        },
      },
    });
    expect(buildStartCount).toBe(1);
  } finally {
    await builder.close();
  }
});

it('upgrades a pending subset build to a full revision when source files change', async () => {
  /// @case
  /// 1. A default-only build is pending behind an exclusive watcher task.
  /// 2. A domain source file changes before the pending build starts.
  /// @expect
  /// The changed revision builds both default and headless exactly once, so neither profile misses the source update.
  const project = await makeTempDir();
  const entry = join(project, 'src', 'index.ts');
  await fs.outputFile(join(project, 'oms.config.mjs'), [
    'export default {',
    '  profiles: { headless: {} },',
    '};',
  ].join('\n'));
  await fs.outputFile(entry, 'export const marker = "before-pending-subset";');
  const initialBuildEnd = deferred<void>();
  let buildEndCount = 0;
  const ctx = new ServerContext({
    invoke: async (method: string) => {
      if (method === 'build-end' && ++buildEndCount === 1) {
        initialBuildEnd.resolve();
      }
    },
  } as any);
  const builder = new OmsBuilder(ctx, { project });

  try {
    await expect(rebuildDefault(builder, {
      extensionBuildOptions: [],
      profiles: ['default'],
    })).resolves.toMatchObject({ ok: true });
    await initialBuildEnd.promise;

    const watcher = (builder as any)._watcher;
    const releaseExclusiveTask = deferred<void>();
    const exclusiveTask = watcher._taskQueue.queueTask({
      type: 'inlineUUIDs',
      exec: async () => await releaseExclusiveTask.promise,
    });
    const profileBuilds: string[] = [];
    const runProfileBuild = watcher._runProfileBuild.bind(watcher);
    vi.spyOn(watcher, '_runProfileBuild').mockImplementation(async (profile: string) => {
      profileBuilds.push(profile);
      return await runProfileBuild(profile);
    });

    const defaultBuild = watcher.build({ profiles: ['default'] });
    await fs.outputFile(entry, 'export const marker = "after-pending-subset";');
    await vi.waitFor(() => {
      expect(watcher._fileQueue[entry]).toBe('change');
    });
    releaseExclusiveTask.resolve();

    await exclusiveTask;
    await expect(defaultBuild).resolves.toMatchObject({
      default: { ok: true },
    });
    await vi.waitFor(() => {
      expect(profileBuilds).toEqual(expect.arrayContaining(['default', 'headless']));
    });
    expect(profileBuilds.filter((profile) => profile === 'default')).toHaveLength(1);
    expect(profileBuilds.filter((profile) => profile === 'headless')).toHaveLength(1);
  } finally {
    await builder.close();
  }
});

it('keeps passive default completion when a headless waiter attaches to the revision', async () => {
  /// @case
  /// 1. A source change starts a passive full revision and pauses during build-start.
  /// 2. A headless-only caller attaches before the profile lanes run.
  /// @expect
  /// The caller receives the headless result, while passive-build-end still reports the completed passive revision.
  const project = await makeTempDir();
  const entry = join(project, 'src', 'index.ts');
  await fs.outputFile(join(project, 'oms.config.mjs'), [
    'export default {',
    '  profiles: { headless: {} },',
    '};',
  ].join('\n'));
  await fs.outputFile(entry, 'export const marker = "before-headless-attach";');
  const initialBuildEnd = deferred<void>();
  const passiveBuildStart = deferred<void>();
  const releasePassivePreparation = deferred<void>();
  let buildStartCount = 0;
  const ctx = new ServerContext({
    invoke: async (method: string) => {
      if (method === 'build-start') {
        buildStartCount++;
        if (buildStartCount === 2) {
          passiveBuildStart.resolve();
          await releasePassivePreparation.promise;
        }
      } else if (method === 'build-end' && buildStartCount === 1) {
        initialBuildEnd.resolve();
      }
    },
  } as any);
  const builder = new OmsBuilder(ctx, { project });

  try {
    await expect(rebuildDefault(builder, {
      extensionBuildOptions: [],
      profiles: ['default'],
    })).resolves.toMatchObject({ ok: true });
    await initialBuildEnd.promise;

    const passiveBuildEnd = waitForPassiveBuildEnd(builder);
    await fs.outputFile(entry, 'export const marker = "after-headless-attach";');
    await passiveBuildStart.promise;
    const headlessBuild = builder.rebuild({ profiles: ['headless'] });
    releasePassivePreparation.resolve();

    await expect(headlessBuild).resolves.toMatchObject({
      headless: { ok: true },
    });
    await expect(passiveBuildEnd).resolves.toMatchObject({
      profileResults: {
        default: { ok: true },
        headless: { ok: true },
      },
    });
    expect(buildStartCount).toBe(2);
  } finally {
    await builder.close();
  }
});

it('watches new default dependencies before the headless lane finishes', async () => {
  /// @case
  /// 1. A source change makes default discover a new dependency outside the OMS source root.
  /// 2. The headless lane remains blocked after default succeeds, then the new dependency changes.
  /// @expect
  /// Default publishes its dependencies after writing output, so the change queues one following revision.
  const project = await makeTempDir();
  const entry = join(project, 'src', 'index.ts');
  const passiveDependency = join(project, 'shared', 'runtime-dependency.ts');
  await fs.outputFile(join(project, 'oms.config.mjs'), [
    'export default {',
    '  profiles: { headless: {} },',
    '};',
  ].join('\n'));
  await fs.outputFile(entry, 'export const marker = "before-runtime-completion";');
  await fs.outputFile(passiveDependency, 'export const runtimeValue = "before";');
  const initialBuildEnd = deferred<void>();
  let buildStartCount = 0;
  let buildEndCount = 0;
  const ctx = new ServerContext({
    invoke: async (method: string) => {
      if (method === 'build-start') {
        buildStartCount++;
      } else if (method === 'build-end') {
        buildEndCount++;
        if (buildEndCount === 1) {
          initialBuildEnd.resolve();
        }
      }
    },
  } as any);
  const builder = new OmsBuilder(ctx, { project });

  try {
    await expect(rebuildDefault(builder, {
      extensionBuildOptions: [],
      profiles: ['default'],
    })).resolves.toMatchObject({ ok: true });
    await initialBuildEnd.promise;

    const watcher = (builder as any)._watcher;
    const headlessStarted = deferred<void>();
    const releaseHeadless = deferred<void>();
    const runProfileBuild = watcher._runProfileBuild.bind(watcher);
    vi.spyOn(watcher, '_runProfileBuild').mockImplementation(async (profile: string) => {
      if (profile === 'headless') {
        headlessStarted.resolve();
        await releaseHeadless.promise;
      }
      return await runProfileBuild(profile);
    });

    const defaultProfileBuildEnd = waitForPassiveProfileBuildEnd(builder, 'default');
    const passiveBuildEnd = waitForPassiveBuildEnd(builder);
    let passiveSettled = false;
    void passiveBuildEnd.then(() => {
      passiveSettled = true;
    });
    await fs.outputFile(entry, [
      'import { runtimeValue } from "../shared/runtime-dependency";',
      'export const marker = runtimeValue;',
    ].join('\n'));

    await headlessStarted.promise;
    await expect(defaultProfileBuildEnd).resolves.toMatchObject({
      profile: 'default',
      result: { ok: true },
    });
    await Promise.resolve();
    expect(passiveSettled).toBe(false);
    expect(buildEndCount).toBe(1);
    // Verify dependency updates are observed while the headless lane is still running.
    await fs.outputFile(passiveDependency, 'export const runtimeValue = "after";');

    releaseHeadless.resolve();
    await expect(passiveBuildEnd).resolves.toMatchObject({
      profileResults: {
        default: { ok: true },
        headless: { ok: true },
      },
    });
    await vi.waitFor(() => {
      expect(buildStartCount).toBe(3);
      expect(buildEndCount).toBe(3);
    });
  } finally {
    await builder.close();
  }
});

it('rejects empty and unknown profile requests', async () => {
  /// @case
  /// IPC callers submit an empty profile list or an unknown build profile.
  /// @expect
  /// Both requests fail before a no-op or undefined profile build can be reported as successful.
  const project = await makeTempDir();
  await fs.outputFile(join(project, 'src', 'index.ts'), 'export const marker = "profile-validation";');
  const ctx = new ServerContext({
    invoke: async () => undefined,
  } as any);
  const builder = new OmsBuilder(ctx, { project });

  try {
    await expect(builder.rebuild({ profiles: [] })).rejects.toThrow('at least one profile');
    await expect(builder.rebuild({ profiles: ['unknown' as any] })).rejects.toThrow('Unknown OMS build profile');
  } finally {
    await builder.close();
  }
});

it('rejects a pending profile waiter when the watcher closes', async () => {
  /// @case
  /// 1. An exclusive watcher task keeps a default build pending in the task queue.
  /// 2. The OMS watcher closes before that build starts.
  /// @expect
  /// The profile waiter rejects instead of remaining permanently pending after TaskQueue abort clears the queued task.
  const project = await makeTempDir();
  await fs.outputFile(join(project, 'src', 'index.ts'), 'export const marker = "close-pending-build";');
  const initialBuildEnd = deferred<void>();
  let buildEndCount = 0;
  const ctx = new ServerContext({
    invoke: async (method: string) => {
      if (method === 'build-end' && ++buildEndCount === 1) {
        initialBuildEnd.resolve();
      }
    },
  } as any);
  const builder = new OmsBuilder(ctx, { project });

  await expect(rebuildDefault(builder, {
    extensionBuildOptions: [],
    profiles: ['default'],
  })).resolves.toMatchObject({ ok: true });
  await initialBuildEnd.promise;

  const watcher = (builder as any)._watcher;
  const releaseExclusiveTask = deferred<void>();
  const exclusiveTask = watcher._taskQueue.queueTask({
    type: 'inlineUUIDs',
    exec: async () => await releaseExclusiveTask.promise,
  });
  const pendingBuild = watcher.build({ profiles: ['default'] });

  const closePromise = watcher.close({ waitForTasks: false });
  await expect(pendingBuild).rejects.toThrow('OMS watcher closed');
  releaseExclusiveTask.resolve();
  await exclusiveTask;
  await closePromise;
});

it('rejects public watcher operations after close', async () => {
  /// @case
  /// The OMS watcher has completed shutdown before callers issue explicit operations.
  /// @expect
  /// Every public operation rejects as closed instead of reporting a silent success.
  const project = await makeTempDir();
  await fs.outputFile(join(project, 'src', 'index.ts'), 'export const marker = "closed-operations";');
  const ctx = new ServerContext({
    invoke: async () => undefined,
  } as any);
  const builder = new OmsBuilder(ctx, { project });

  await expect(rebuildDefault(builder, {
    extensionBuildOptions: [],
    profiles: ['default'],
  })).resolves.toMatchObject({ ok: true });
  const watcher = (builder as any)._watcher;
  const config = watcher._config;
  await watcher.close();

  await expect(watcher.updateBuildOptions({ extensionBuildOptions: [] })).rejects.toThrow('OMS watcher closed');
  await expect(watcher.updateConfig(config)).rejects.toThrow('OMS watcher closed');
  await expect(watcher.inlineUUIDs()).rejects.toThrow('OMS watcher closed');
  await expect(watcher.build({ profiles: ['default'] })).rejects.toThrow('OMS watcher closed');
  await expect(watcher.buildProd({
    buildDir: join(project, 'build', 'closed'),
    debug: true,
    sourceMaps: false,
    platform: 'web-mobile',
    headless: false,
  })).rejects.toThrow('OMS watcher closed');

  await (builder as any)._clean();
});

it('rejects a pending public rebuild when the builder closes', async () => {
  /// @case
  /// 1. An outer builder task is running before watcher initialization begins.
  /// 2. A public rebuild remains pending behind it when the builder closes.
  /// @expect
  /// Closing the builder rejects the pending public caller instead of leaving its start task unresolved.
  const project = await makeTempDir();
  await fs.outputFile(join(project, 'src', 'index.ts'), 'export const marker = "close-pending-public-build";');
  const ctx = new ServerContext({
    invoke: async () => undefined,
  } as any);
  const builder = new OmsBuilder(ctx, { project });
  const releaseExclusiveTask = deferred<void>();
  const exclusiveTask = (builder as any)._taskQueue.queueTask({
    type: 'inlineUUIDs',
    exec: async () => await releaseExclusiveTask.promise,
  });
  const pendingBuild = builder.rebuild({ profiles: ['default'] });

  const closePromise = builder.close();
  await expect(pendingBuild).rejects.toThrow('Task queue aborted');
  releaseExclusiveTask.resolve();
  await exclusiveTask;
  await closePromise;
});

it('does not schedule a watcher build from file changes while close is waiting', async () => {
  /// @case
  /// 1. The watcher begins closing while an exclusive running task delays abort completion.
  /// 2. A real domain source change arrives before that running task finishes.
  /// @expect
  /// The closing watcher does not accept a new passive build that could race watcher and domain cleanup.
  const project = await makeTempDir();
  const entry = join(project, 'src', 'index.ts');
  await fs.outputFile(entry, 'export const marker = "before-close-file-change";');
  const initialBuildEnd = deferred<void>();
  let buildEndCount = 0;
  const ctx = new ServerContext({
    invoke: async (method: string) => {
      if (method === 'build-end' && ++buildEndCount === 1) {
        initialBuildEnd.resolve();
      }
    },
  } as any);
  const builder = new OmsBuilder(ctx, { project });

  await expect(rebuildDefault(builder, {
    extensionBuildOptions: [],
    profiles: ['default'],
  })).resolves.toMatchObject({ ok: true });
  await initialBuildEnd.promise;

  const watcher = (builder as any)._watcher;
  const releaseExclusiveTask = deferred<void>();
  const exclusiveTask = watcher._taskQueue.queueTask({
    type: 'inlineUUIDs',
    exec: async () => await releaseExclusiveTask.promise,
  });
  const profileBuilds = vi.spyOn(watcher, '_runProfileBuild');
  const closePromise = watcher.close();
  await fs.outputFile(entry, 'export const marker = "after-close-file-change";');
  await vi.waitFor(() => {
    expect(watcher._fileQueue[entry]).toBe('change');
  });

  releaseExclusiveTask.resolve();
  await exclusiveTask;
  await closePromise;
  await setTimeout(150);
  expect(profileBuilds).not.toHaveBeenCalled();
});

it('does not queue a production build when close wins during config loading', async () => {
  /// @case
  /// 1. A production build begins and pauses while loading its production config.
  /// 2. The OMS builder closes before that config load finishes.
  /// @expect
  /// Releasing the config load rejects the production caller as closed instead of queuing work after abort and cleanup.
  const project = await makeTempDir();
  await fs.outputFile(join(project, 'src', 'index.ts'), 'export const marker = "prod-close-config-load";');
  const ctx = new ServerContext({
    invoke: async () => undefined,
  } as any);
  const builder = new OmsBuilder(ctx, { project });

  await expect(rebuildDefault(builder, {
    extensionBuildOptions: [],
    profiles: ['default'],
  })).resolves.toMatchObject({ ok: true });
  const watcher = (builder as any)._watcher;
  const productionConfigLoadStarted = deferred<void>();
  const releaseProductionConfigLoad = deferred<void>();
  const configReady = vi.spyOn(OmsProjectConfigWatcher.prototype, 'ready').mockImplementationOnce(async () => {
    productionConfigLoadStarted.resolve();
    await releaseProductionConfigLoad.promise;
    return watcher._config;
  });

  try {
    const productionBuild = builder.buildProd({
      buildDir: join(project, 'build', 'close-during-config'),
      debug: true,
      sourceMaps: false,
      platform: 'web-mobile',
      headless: false,
    });
    await productionConfigLoadStarted.promise;
    const closePromise = builder.close({ waitForTasks: false });
    releaseProductionConfigLoad.resolve();

    await expect(productionBuild).rejects.toThrow('OMS watcher closed');
    await closePromise;
  } finally {
    configReady.mockRestore();
  }
});

async function rebuildDefault(
  builder: OmsBuilder,
  options: BuildOptions & RebuildOptions,
) {
  const profileResults = await rebuildProfiles(builder, options);
  const defaultResult = profileResults.default;
  if (!defaultResult) {
    throw new Error('Missing default profile result');
  }
  return defaultResult;
}

async function rebuildProfiles(
  builder: OmsBuilder,
  options: BuildOptions & RebuildOptions,
) {
  const { profiles, ...buildOptions } = options;
  await builder.updateBuildOptions(buildOptions);
  return await builder.rebuild(profiles ? { profiles } : {});
}

async function makeTempDir() {
  const dir = await fs.mkdtemp(join(tmpdir(), 'oms-builder-'));
  tempDirs.push(dir);
  return dir;
}

function waitForPassiveBuildEnd(builder: OmsBuilder) {
  return new Promise((resolve, reject) => {
    const timeout = globalThis.setTimeout(() => {
      builder.off('passive-build-end', onEnd);
      reject(new Error('Timed out waiting for passive build end'));
    }, 5000);
    const onEnd = (info: unknown) => {
      globalThis.clearTimeout(timeout);
      resolve(info);
    };
    builder.once('passive-build-end', onEnd);
  });
}

function waitForPassiveProfileBuildEnd(builder: OmsBuilder, profile: 'default' | 'headless') {
  return new Promise((resolve, reject) => {
    const timeout = globalThis.setTimeout(() => {
      builder.off('passive-profile-build-end', onEnd);
      reject(new Error(`Timed out waiting for passive ${profile} profile build end`));
    }, 5000);
    const onEnd = (info: { profile: 'default' | 'headless' }) => {
      if (info.profile !== profile) {
        return;
      }
      globalThis.clearTimeout(timeout);
      builder.off('passive-profile-build-end', onEnd);
      resolve(info);
    };
    builder.on('passive-profile-build-end', onEnd);
  });
}

async function readJavaScriptOutput(root: string): Promise<string> {
  return (await readJavaScriptFiles(root)).map(({ source }) => source).join('\n');
}

async function readJavaScriptFiles(root: string): Promise<Array<{ path: string; source: string }>> {
  const files: Array<{ path: string; source: string }> = [];
  const visit = async (dir: string) => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile() && entry.name.endsWith('.js')) {
        files.push({ path, source: await fs.readFile(path, 'utf8') });
      }
    }
  };
  await visit(root);
  return files;
}

function getGeneratedPosition(source: string, marker: string) {
  const markerIndex = source.indexOf(marker);
  expect(markerIndex).toBeGreaterThanOrEqual(0);
  const precedingSource = source.slice(0, markerIndex);
  const lastLineBreak = precedingSource.lastIndexOf('\n');
  return {
    line: precedingSource.split('\n').length,
    column: markerIndex - lastLineBreak - 1,
  };
}

function expectProfileOutput(output: string, expected: {
  includes: string[];
  excludes: string[];
}) {
  for (const marker of expected.includes) {
    expect(output).toContain(marker);
  }
  for (const marker of expected.excludes) {
    expect(output).not.toContain(marker);
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve_, reject_) => {
    resolve = resolve_;
    reject = reject_;
  });
  return {
    promise,
    resolve,
    reject,
  };
}

async function outputNodePackage(root: string, packageName: string, source: string, extraPackageJson: Record<string, unknown> = {}) {
  const packageDir = join(root, 'node_modules', ...packageName.split('/'));
  await fs.outputJson(join(packageDir, 'package.json'), {
    name: packageName,
    type: 'module',
    main: './index.js',
    ...extraPackageJson,
  }, {
    spaces: 2,
  });
  await fs.outputFile(join(packageDir, 'index.js'), source);
}

function makeOmsTypesReference(project: string, typingDirName: string, omsPackageRoot: string) {
  const typingOutDir = join(project, 'temp', 'oms', typingDirName);
  const omsTypesPath = fs.realpathSync(join(omsPackageRoot, 'types', 'oms.d.ts'));
  let referencePath = relative(typingOutDir, omsTypesPath);
  const absolute = isAbsolute(referencePath);
  referencePath = referencePath.replace(/\\/g, '/');
  if (!absolute && !referencePath.startsWith('.')) {
    referencePath = `./${referencePath}`;
  }
  return `/// <reference path=${JSON.stringify(referencePath)} />`;
}

function typeCheck(rootNames: string[], overrides: ts.CompilerOptions = {}) {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.Node16,
    moduleResolution: ts.ModuleResolutionKind.Node16,
    strict: true,
    skipLibCheck: false,
    noEmit: true,
    ...overrides,
  };
  const program = ts.createProgram(rootNames, options);
  return ts.getPreEmitDiagnostics(program).map((diagnostic) => {
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
    if (!diagnostic.file || diagnostic.start === undefined) {
      return message;
    }
    const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
    return `${diagnostic.file.fileName}:${line + 1}:${character + 1} ${message}`;
  });
}
