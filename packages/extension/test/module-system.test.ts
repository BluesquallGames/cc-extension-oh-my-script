import { beforeEach, describe, expect, it, vi } from 'vitest';
import { vol } from 'memfs';
import { ReloadInterruptError, SceneModuleSystem } from '../src/contributions/scene/module-system';
import { OmsScriptRuntime } from '../src/contributions/scene/oms-script-runtime';
import { setTimeout } from 'node:timers/promises';

vi.mock('node:fs', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { fs } = require('memfs');
  return {
    ...fs,
    default: fs,
  };
});
vi.mock('node:fs/promises', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { fs } = require('memfs');
  const modifiedFsPromises = {
    ...fs.promises,
    readFile: async (...args: Parameters<typeof fs.promises.readFile>) => {
      await setTimeout(100);
      return fs.promises.readFile.apply(fs, args);
    },
  };
  return {
    ...modifiedFsPromises,
    default: modifiedFsPromises,
  };
});
vi.mock('cc', () => {
  return {
    omsTestValue: 'cc-module',
    cclegacy: {
      _RF: {
        reset: vi.fn(),
        peek: vi.fn(),
      },
    },

    js: {

    },
  };
});
vi.mock('cc/editor/populate-internal-constants', () => {
  return {
    default: {
      EDITOR: true,
      DEBUG: true,
    },
  };
});
vi.mock(import('../src/logger.js'), () => {
  return {
    logger: console,
  };
});
vi.hoisted(() => {
  const mockProjectPath = '/__oms_test__/';
  vi.stubGlobal('Editor', {
    Project: {
      get path() {
        return mockProjectPath;
      },

      get tmpDir() {
        return mockProjectPath + 'temp';
      },
    },
  });

  vi.stubGlobal('EditorExtends', {
    on: vi.fn(),
    removeListener: vi.fn(),
  });
});

beforeEach(() => {
  vol.reset();
  Reflect.deleteProperty(globalThis, '__oms_import__');
  Reflect.deleteProperty(globalThis, 'System');
  Reflect.deleteProperty(globalThis, '__omsRuntimeReloadCount');
});

describe('module system', () => {
  let moduleSystem: SceneModuleSystem = undefined!;

  beforeEach(() => {
    vol.fromJSON({
      'metadata.js': makeMetadataJs([
        ['main', false],
      ]),
      'bundle-main.js': makeSimpleSystemJs(``),
    }, '/__oms_test__/temp/oms/out/');
    moduleSystem = new SceneModuleSystem();
  });

  it('should build queued', async () => {
    const r1 = moduleSystem.reload();
    await setTimeout(50);
    const r2 = moduleSystem.reload();
    const r3 = moduleSystem.reload();
    await expect(r1).rejects.toThrowError(ReloadInterruptError);
    expect(r2).toBe(r3);
    await Promise.all([r2, r3]);
  });

  it('imports public OMS exports', async () => {
    vol.fromJSON({
      'metadata.js': makeMetadataJs([
        ['main', false],
      ], {
        'some-plugin:.': 'exports/some-plugin/index',
        'some-plugin:a': 'exports/some-plugin/a',
      }),
      'bundle-main.js': makeSimpleSystemJs(``),
      'exports/some-plugin/index.js': makeSimpleSystemJs(`exports("value", 40)`),
      'exports/some-plugin/a.js': makeSimpleSystemJs(`exports("value", 42)`),
    }, '/__oms_test__/temp/oms/out/');
    moduleSystem = new SceneModuleSystem();

    await moduleSystem.reload();

    await expect(moduleSystem.import('some-plugin:a')).resolves.toMatchObject({
      value: 42,
    });
    await expect(moduleSystem.import('oms://some-plugin')).resolves.toMatchObject({
      value: 40,
    });
    await expect(moduleSystem.import('oms://some-plugin/a')).resolves.toMatchObject({
      value: 42,
    });
    await expect(moduleSystem.import('a')).rejects.toThrowError(
      `'a' is not a valid OMS entry module.`);
  });

  it('does not install global import by default', async () => {
    await moduleSystem.reload();

    expect(globalThis).not.toHaveProperty('__oms_import__');
  });

  it('installs global import when enabled', async () => {
    vol.fromJSON({
      'metadata.js': makeMetadataJs([
        ['main', false],
      ], {
        'some-plugin:.': 'exports/some-plugin/index',
      }),
      'bundle-main.js': makeSimpleSystemJs(``),
      'exports/some-plugin/index.js': makeSimpleSystemJs(`exports("value", 40)`),
    }, '/__oms_test__/temp/oms/out/');
    moduleSystem = new SceneModuleSystem({
      globalImport: true,
    });

    await moduleSystem.reload();

    expect(globalThis).toHaveProperty('__oms_import__');
    await expect((globalThis as unknown as {
      __oms_import__: (moduleId: string) => Promise<unknown>;
    }).__oms_import__('oms://some-plugin')).resolves.toMatchObject({
      value: 40,
    });
  });

  it('loads built-in external modules without editor SystemJS', async () => {
    /// @case
    /// 1. A compiled OMS bundle imports both cc and cc/env.
    /// 2. The editor global SystemJS import hook is present but unusable.
    /// @expect
    /// The module system supplies built-in cc externals itself and never calls editor SystemJS.
    const editorSystemImport = vi.fn(() => {
      return Promise.reject(new Error('editor SystemJS should not be used'));
    });
    vi.stubGlobal('System', {
      import: editorSystemImport,
    });
    vol.fromJSON({
      'metadata.js': makeMetadataJs([
        ['main', false],
      ]),
      'bundle-main.js': makeSystemJs(
        ['cc', 'cc/env'],
        `
        exports("ccValue", cc.omsTestValue);
        exports("editor", env.EDITOR);
        exports("debug", env.DEBUG);
        `,
        ['cc', 'env'],
      ),
    }, '/__oms_test__/temp/oms/out/');
    moduleSystem = new SceneModuleSystem();

    await moduleSystem.reload();

    await expect(moduleSystem.import('main')).resolves.toMatchObject({
      ccValue: 'cc-module',
      editor: true,
      debug: true,
    });
    expect(editorSystemImport).not.toHaveBeenCalled();
  });
});

describe('OMS script runtime', () => {
  it('installs global import immediately and lazy loads runtime', async () => {
    /// @case
    /// 1. OMS runtime is created and installs its global import before reload.
    /// 2. A consumer imports package exports through both oms:// and legacy specifiers.
    /// @expect
    /// The stable global import waits for runtime readiness and resolves both specifier forms.
    vol.fromJSON({
      'metadata.js': makeMetadataJs([
        ['main', false],
      ], {
        'some-plugin:.': 'exports/some-plugin/index',
        'some-plugin:a': 'exports/some-plugin/a',
      }),
      'bundle-main.js': makeSimpleSystemJs(``),
      'exports/some-plugin/index.js': makeSimpleSystemJs(`exports("value", 40)`),
      'exports/some-plugin/a.js': makeSimpleSystemJs(`exports("value", 42)`),
    }, '/__oms_test__/temp/oms/out/');
    const runtime = new OmsScriptRuntime({
      label: 'test',
    });

    runtime.installGlobalImport();

    const omsImport = getOmsImport();
    await expect(omsImport('oms://some-plugin')).resolves.toMatchObject({
      value: 40,
    });
    await expect(omsImport('oms://some-plugin/a')).resolves.toMatchObject({
      value: 42,
    });
    await expect(omsImport('some-plugin:a')).resolves.toMatchObject({
      value: 42,
    });
  });

  it('does not reload project scripts again when ensureReady is already satisfied', async () => {
    /// @case
    /// 1. A consumer import triggers the OMS runtime's initial lazy reload.
    /// 2. asset-db startup later asks the same runtime to ensure readiness.
    /// @expect
    /// The startup ensure observes the ready runtime and does not execute project scripts again.
    const state = globalThis as typeof globalThis & {
      __omsRuntimeReloadCount?: number;
    };
    state.__omsRuntimeReloadCount = 0;
    vol.fromJSON({
      'metadata.js': makeMetadataJs([
        ['main', false],
      ], {
        'some-plugin:.': 'exports/some-plugin/index',
      }),
      'bundle-main.js': makeSimpleSystemJs(`
        globalThis.__omsRuntimeReloadCount = (globalThis.__omsRuntimeReloadCount ?? 0) + 1
      `),
      'exports/some-plugin/index.js': makeSimpleSystemJs(`exports("value", 40)`),
    }, '/__oms_test__/temp/oms/out/');
    const runtime = new OmsScriptRuntime({
      label: 'test',
    });
    runtime.installGlobalImport();

    await expect(getOmsImport()('oms://some-plugin')).resolves.toMatchObject({
      value: 40,
    });
    expect(state.__omsRuntimeReloadCount).toBe(1);

    await runtime.ensureReady('asset-db afterPreStart');

    expect(state.__omsRuntimeReloadCount).toBe(1);
  });

  it('waits for a pending runtime reload', async () => {
    /// @case
    /// 1. A runtime reload is already pending.
    /// 2. A consumer import arrives through the stable global import.
    /// @expect
    /// The import waits for the pending reload and then resolves against the fresh runtime.
    vol.fromJSON({
      'metadata.js': makeMetadataJs([
        ['main', false],
      ], {
        'some-plugin:.': 'exports/some-plugin/index',
      }),
      'bundle-main.js': makeSimpleSystemJs(``),
      'exports/some-plugin/index.js': makeSimpleSystemJs(`exports("value", 40)`),
    }, '/__oms_test__/temp/oms/out/');
    const runtime = new OmsScriptRuntime({
      label: 'test',
    });
    runtime.installGlobalImport();

    const reloadPromise = runtime.reload('test pending reload');
    const importPromise = getOmsImport()('oms://some-plugin');

    await expect(importPromise).resolves.toMatchObject({
      value: 40,
    });
    await reloadPromise;
  });

  it('rejects with an OMS runtime error when build fails', async () => {
    /// @case
    /// 1. A lazy import asks the runtime to ensure a build.
    /// 2. The build result reports failure.
    /// @expect
    /// The import rejects with an OMS runtime error while leaving the global import installed.
    const runtime = new OmsScriptRuntime({
      label: 'asset-db',
      ensureBuild: () => Promise.resolve(({
        ok: false,
        error: {
          message: 'build boom',
        },
      })),
    });

    runtime.installGlobalImport();

    const omsImport = getOmsImport();
    await expect(omsImport('oms://some-plugin')).rejects.toThrowError(
      'OMS build failed in asset-db: build boom');
    expect(globalThis).toHaveProperty('__oms_import__');
  });

  it('recovers after a failed build is followed by a successful build', async () => {
    /// @case
    /// 1. The first lazy import sees a failed runtime build.
    /// 2. The next lazy import sees a successful build.
    /// @expect
    /// Runtime readiness is retried and later imports recover without reinstalling the global
    /// function.
    vol.fromJSON({
      'metadata.js': makeMetadataJs([
        ['main', false],
      ], {
        'some-plugin:.': 'exports/some-plugin/index',
      }),
      'bundle-main.js': makeSimpleSystemJs(``),
      'exports/some-plugin/index.js': makeSimpleSystemJs(`exports("value", 40)`),
    }, '/__oms_test__/temp/oms/out/');
    let buildCount = 0;
    const runtime = new OmsScriptRuntime({
      label: 'asset-db',
      ensureBuild: () => {
        buildCount += 1;
        if (buildCount === 1) {
          return Promise.resolve({
            ok: false,
            error: {
              message: 'first build failed',
            },
          });
        }
        return Promise.resolve({
          ok: true,
          affectedFiles: [],
        });
      },
    });
    runtime.installGlobalImport();

    const omsImport = getOmsImport();
    await expect(omsImport('oms://some-plugin')).rejects.toThrowError(
      'OMS build failed in asset-db: first build failed');
    await expect(omsImport('oms://some-plugin')).resolves.toMatchObject({
      value: 40,
    });
    expect(buildCount).toBe(2);
  });
});

function makeMetadataJs(entries: Array<[bundle: string, editor: boolean]>, exportEntries:
Record<string, string> = {}) {
  return `
  System.register([], (function (exports) {
    'use strict';
    return {
      execute: (function () {
        var omsEntry_metadata = exports("default", {
          entries: ${JSON.stringify(entries)},
          exports: ${JSON.stringify(exportEntries)},
        });

      })
    };
  }));
  `;
}

function getOmsImport() {
  const omsImport = (globalThis as typeof globalThis & {
    __oms_import__?: (moduleId: string) => Promise<unknown>;
  }).__oms_import__;
  if (!omsImport) {
    throw new Error('__oms_import__ was not installed');
  }
  return omsImport;
}

function makeSimpleSystemJs(code: string) {
  return makeSystemJs([], code);
}

function makeSystemJs(deps: string[], code: string, setterNames: string[] = []) {
  const setters = setterNames.map((setterName) => `(m) => { ${setterName} = m; }`).join(',');
  const declarations = setterNames.map((setterName) => `let ${setterName};`).join('\n');
  return `
  System.register(${JSON.stringify(deps)}, (function (exports) {
    'use strict';
    ${declarations}
    return {
      setters: [${setters}],
      execute: (function () {
        ${code};
      })
    };
  }));
  `;
}
