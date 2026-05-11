import { beforeEach, describe, expect, it, vi } from 'vitest';
import { vol } from 'memfs';
import { ReloadInterruptError, SceneModuleSystem } from '../src/contributions/scene/module-system';
import { setTimeout } from 'node:timers/promises';
import { type logger } from '../src/logger.js';
import { nextTick } from 'node:process';

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
vi.mock(import('../src/logger.js'), () => {
  return {
    logger: console as unknown as typeof logger,
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
});

function makeMetadataJs(entries: Array<[bundle: string, editor: boolean]>) {
  return `
  System.register([], (function (exports) {
    'use strict';
    return {
      execute: (function () {
        var omsEntry_metadata = exports("default", {
          entries: ${JSON.stringify(entries)},
        });

      })
    };
  }));
  `;
}

function makeSimpleSystemJs(code: string) {
  return `
  System.register([], (function (exports) {
    'use strict';
    return {
      execute: (function () {
        ${code};
      })
    };
  }));
  `;
}
