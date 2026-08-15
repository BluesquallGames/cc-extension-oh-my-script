import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BuildProfileResult } from '@oms/build-core/protocol';
import { vol } from 'memfs';

const editorRequest = vi.hoisted(() => vi.fn());

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
  return {
    ...fs.promises,
    default: fs.promises,
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
    js: {},
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
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    },
  };
});

vi.hoisted(() => {
  const mockProjectPath = '/__oms_scene_startup_test__/';
  vi.stubGlobal('Editor', {
    Project: {
      get path() {
        return mockProjectPath;
      },

      get tmpDir() {
        return mockProjectPath + 'temp';
      },
    },
    Message: {
      request: editorRequest,
    },
  });

  vi.stubGlobal('EditorExtends', {
    on: vi.fn(),
    removeListener: vi.fn(),
  });
});

beforeEach(() => {
  vi.resetModules();
  vol.reset();
  editorRequest.mockReset();
  Reflect.deleteProperty(globalThis, '__oms_import__');
  Reflect.deleteProperty(globalThis, 'System');
  Reflect.deleteProperty(globalThis, '__sceneRuntimeLoadCount');
});

describe('scene OMS runtime startup', () => {
  it('waits for the built project scripts to execute before completing scene contribution load', async () => {
    /// @case
    /// 1. Vortex loads the OMS scene contribution while its initial worker build is pending.
    /// 2. The build completes and the real OMS runtime executes the built project entry.
    /// @expect
    /// Scene contribution load stays pending until the project entry has executed, so deserialization cannot race class registration.
    const startupBuild = deferred<BuildProfileResult>();
    editorRequest.mockReturnValue(startupBuild.promise);
    vol.fromJSON({
      'metadata.js': makeMetadataJs(),
      'bundle-main.js': makeBundleJs(`
        globalThis.__sceneRuntimeLoadCount = (globalThis.__sceneRuntimeLoadCount ?? 0) + 1
      `),
    }, '/__oms_scene_startup_test__/temp/oms/out/');
    const scene = await import('../src/contributions/scene/index');
    let loadCompleted = false;

    const loadPromise = scene.load().then(() => {
      loadCompleted = true;
    });
    await Promise.resolve();

    expect(editorRequest).toHaveBeenCalledWith('oh-my-script', 'ensure-default-profile');
    expect(loadCompleted).toBe(false);
    expect(globalThis).not.toHaveProperty('__sceneRuntimeLoadCount');

    startupBuild.resolve({
      ok: true,
      affectedFiles: [],
    });
    await loadPromise;

    expect(loadCompleted).toBe(true);
    expect(globalThis).toHaveProperty('__sceneRuntimeLoadCount', 1);
  });
});

function deferred<T>() {
  let resolve: (value: T) => void = undefined!;
  let reject: (reason?: unknown) => void = undefined!;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return {
    promise,
    resolve,
    reject,
  };
}

function makeMetadataJs() {
  return `
  System.register([], (function (exports) {
    'use strict';
    return {
      execute: (function () {
        exports("default", {
          entries: [['main', false]],
          exports: {},
        });
      })
    };
  }));
  `;
}

function makeBundleJs(code: string) {
  return `
  System.register([], (function () {
    'use strict';
    return {
      setters: [],
      execute: (function () {
        ${code};
      })
    };
  }));
  `;
}
