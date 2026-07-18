import { afterEach, expect, it } from 'vitest';
import fs from 'fs-extra';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import * as ts from 'typescript';
import { OmsBuilder } from '../src/oms-builder.js';
import { ServerContext } from '../src/server-context.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => fs.remove(dir)));
  tempDirs.length = 0;
});

it('does not emit passive-build-end when a pending passive build is claimed by an active build', async () => {
  const project = await makeTempDir();
  await fs.ensureDir(join(project, 'src'));
  const ctx = new ServerContext({
    invoke: async () => undefined,
  } as any);
  const builder = new OmsBuilder(ctx, {
    project,
  });

  try {
    await builder.rebuild({
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
      ok: true,
    });
    await setTimeout(50);

    expect(passiveBuildEndCount).toBe(0);
  } finally {
    await (builder as any)._clean();
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
    await expect(builder.rebuild({
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
    await expect(builder.rebuild({
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
    await expect(builder.rebuild({
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
    await expect(builder.rebuild({
      extensionBuildOptions: [],
    })).resolves.toMatchObject({
      ok: true,
    });

    let passiveBuildEnd = waitForPassiveBuildEnd(builder);
    await fs.outputFile(component, '(globalThis as any).__omsDomainSourceMarker = "domain-source-added";');
    await expect(passiveBuildEnd).resolves.toMatchObject({
      result: {
        ok: true,
      },
    });
    await expect(fs.readFile(join(project, 'temp', 'oms', 'out', 'bundle-main.js'), 'utf8')).resolves.toContain('domain-source-added');

    passiveBuildEnd = waitForPassiveBuildEnd(builder);
    await fs.outputFile(component, '(globalThis as any).__omsDomainSourceMarker = "domain-source-changed";');
    await expect(passiveBuildEnd).resolves.toMatchObject({
      result: {
        ok: true,
      },
    });
    const changedOutput = await fs.readFile(join(project, 'temp', 'oms', 'out', 'bundle-main.js'), 'utf8');
    expect(changedOutput).toContain('domain-source-changed');
    expect(changedOutput).not.toContain('domain-source-added');

    passiveBuildEnd = waitForPassiveBuildEnd(builder);
    await fs.remove(component);
    await expect(passiveBuildEnd).resolves.toMatchObject({
      result: {
        ok: true,
      },
    });
    await expect(fs.readFile(join(project, 'temp', 'oms', 'out', 'bundle-main.js'), 'utf8')).resolves.not.toContain('domain-source-changed');
  } finally {
    await (builder as any)._clean();
  }
});

it('emits OMS export module declarations without a generated tsconfig paths file', async () => {
  const project = await makeTempDir();
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
    await expect(builder.rebuild({
      extensionBuildOptions: [
        {
          name: 'text-field',
          path: extensionRoot,
        },
      ],
    })).resolves.toMatchObject({
      ok: true,
    });

    await expect(fs.pathExists(join(project, 'temp', 'oms', 'out', 'tsconfig.json'))).resolves.toBe(false);
    await expect(fs.readFile(join(project, 'temp', 'oms', 'typing', 'index.d.ts'), 'utf8')).resolves.toBe([
      '// This file is generated by Oh My Script. Do not edit.',
      makeOmsTypesReference(project, 'typing'),
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
    await expect(builder.rebuild({
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
    await expect(builder.rebuild({
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
    await expect(builder.rebuild({
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
    await expect(builder.rebuild({
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
    await expect(builder.rebuild({
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
    await expect(builder.rebuild({
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
    await expect(builder.rebuild({
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
    await expect(builder.rebuild({
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
    await expect(builder.rebuild({
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
    await expect(builder.rebuild({
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
    await expect(builder.rebuild({
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
    await expect(builder.rebuild({
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
      result: { ok: true },
    });
    expect(await readJavaScriptOutput(join(project, 'temp', 'oms', 'out'))).toContain('late-shared-component-marker');
    expect(await readJavaScriptOutput(join(project, 'temp', 'oms', 'out-headless'))).toContain('late-shared-component-marker');

    passiveBuild = waitForPassiveBuildEnd(builder);
    await fs.remove(lateSharedComponent);
    await expect(passiveBuild).resolves.toMatchObject({
      result: { ok: true },
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
      result: { ok: true },
    });
    expect(await fs.readFile(join(project, 'temp', 'oms', 'out', 'bundle-main.js'), 'utf8')).not.toContain('late-authority-component-marker');
    expect(await fs.readFile(join(project, 'temp', 'oms', 'out', 'bundle-main.editor.js'), 'utf8')).toContain('late-authority-component-marker');
    expect(await readJavaScriptOutput(join(project, 'temp', 'oms', 'out-headless'))).toContain('late-authority-component-marker');

    passiveBuild = waitForPassiveBuildEnd(builder);
    await fs.remove(lateAuthorityComponent);
    await expect(passiveBuild).resolves.toMatchObject({
      result: { ok: true },
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
      result: { ok: true },
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
      result: { ok: true },
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
      result: { ok: true },
    });
    expect(await readJavaScriptOutput(join(project, 'temp', 'oms', 'out-headless'))).toContain('authority-component-marker');
  } finally {
    await (builder as any)._clean();
  }
});

it('moves the last filtered component between primary and editor bundles after a config hot update', async () => {
  /// @case
  /// 1. A project without an index initially builds one automatically scanned component.
  /// 2. A project config hot update excludes every source from the default primary, then removes the exclusion.
  /// @expect
  /// The component moves into the editor overlay and back, while obsolete primary and editor bundle files are removed.
  const project = await makeTempDir();
  const outDir = join(project, 'temp', 'oms', 'out');
  await fs.outputFile(join(project, 'oms.config.mjs'), [
    'export default {',
    '  profiles: { default: {} },',
    '};',
  ].join('\n'));
  await fs.outputFile(join(project, 'src', 'only.component.ts'), [
    '/// <meta "uuid"="88888888-8888-4888-8888-888888888888"/>',
    'globalThis.__omsOnlyComponent = "only-component-marker";',
  ].join('\n'));
  const ctx = new ServerContext({
    invoke: async () => undefined,
  } as any);
  const builder = new OmsBuilder(ctx, {
    project,
  });

  try {
    await expect(builder.rebuild({
      extensionBuildOptions: [],
    })).resolves.toMatchObject({ ok: true });
    expect(await readJavaScriptOutput(outDir)).toContain('only-component-marker');

    const passiveBuild = waitForPassiveBuildEnd(builder);
    await fs.outputFile(join(project, 'oms.config.mjs'), [
      'export default {',
      '  profiles: { default: { exclude: ["src/**"] } },',
      '};',
    ].join('\n'));
    await expect(passiveBuild).resolves.toMatchObject({
      result: { ok: true },
    });

    expect(await readJavaScriptOutput(outDir)).toContain('only-component-marker');
    await expect(fs.pathExists(join(outDir, 'bundle-main.js'))).resolves.toBe(false);
    await expect(fs.readFile(join(outDir, 'bundle-main.editor.js'), 'utf8')).resolves.toContain('only-component-marker');
    await expect(fs.readFile(join(outDir, 'metadata.js'), 'utf8')).resolves.toContain("['main.editor', true]");

    const restoredBuild = waitForPassiveBuildEnd(builder);
    await fs.outputFile(join(project, 'oms.config.mjs'), [
      'export default {',
      '  profiles: { default: {} },',
      '};',
    ].join('\n'));
    await expect(restoredBuild).resolves.toMatchObject({
      result: { ok: true },
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
    await expect(builder.rebuild({
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
      result: { ok: true },
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
    await expect(builder.rebuild({
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
    await expect(builder.rebuild({
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
    await expect(builder.rebuild({
      extensionBuildOptions: [],
    })).resolves.toMatchObject({
      ok: true,
    });
    await expect(fs.readFile(join(project, 'temp', 'oms', 'out', 'bundle-main.js'), 'utf8')).resolves.toContain('one');

    const passiveBuildEnd = waitForPassiveBuildEnd(builder);
    await fs.outputFile(join(project, '.env'), 'OMS_VALUE=two\n');

    await expect(passiveBuildEnd).resolves.toMatchObject({
      result: {
        ok: true,
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
    await expect(builder.rebuild({
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
      result: {
        ok: true,
      },
    });
    const output = await fs.readFile(join(project, 'temp', 'oms', 'out', 'bundle-main.js'), 'utf8');
    expect(output).toContain('after-recreate-marker');
    expect(output).not.toContain('before-recreate-marker');
  } finally {
    await (builder as any)._clean();
  }
});

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

async function readJavaScriptOutput(root: string): Promise<string> {
  const sources: string[] = [];
  const visit = async (dir: string) => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile() && entry.name.endsWith('.js')) {
        sources.push(await fs.readFile(path, 'utf8'));
      }
    }
  };
  await visit(root);
  return sources.join('\n');
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

function makeOmsTypesReference(project: string, typingDirName: string) {
  const typingOutDir = join(project, 'temp', 'oms', typingDirName);
  const omsTypesPath = fs.realpathSync(join(import.meta.dirname, '..', '..', '..', 'types', 'oms.d.ts'));
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
