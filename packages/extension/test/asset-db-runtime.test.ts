import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BuildProfileResult, BuildProfileResults } from '@oms/build-core/protocol';

const mockState = vi.hoisted(() => {
  return {
    reloadCalls: [] as Array<string | undefined>,
    ensureReadyCalls: [] as Array<string | undefined>,
    reloadWaiters: [] as Array<Promise<void>>,
    ensureReadyWaiters: [] as Array<Promise<void>>,
    requestCalls: [] as Array<{ messageId: string; args: unknown[] }>,
    loggerErrorCalls: [] as unknown[][],
    syncTaskCalls: [] as Array<{
      type: 'add' | 'update' | 'remove';
      name: string;
      message?: string;
      detail?: string;
    }>,
    installGlobalImportCalls: 0,
    rebuildResult: {
      default: { ok: true, affectedFiles: ['src/index.ts'] },
    } as BuildProfileResults,
    defaultProfileResult: { ok: true, affectedFiles: ['src/index.ts'] } as BuildProfileResult,
    rebuildPromise: undefined as Promise<BuildProfileResults> | undefined,
    rebuildError: undefined as Error | undefined,
  };
});

vi.mock(import('../src/logger.js'), () => {
  return {
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      error: vi.fn((...args: unknown[]) => {
        mockState.loggerErrorCalls.push(args);
      }),
    },
  };
});

vi.mock('node:timers/promises', () => {
  return {
    setTimeout: (delay: number) => {
      return new Promise<void>((resolve) => {
        globalThis.setTimeout(resolve, delay);
      });
    },
  };
});

vi.mock(import('../src/utils/request-self.js'), () => {
  return {
    requestSelfWorkerMessage: vi.fn(async (messageId: string, ...args: unknown[]) => {
      mockState.requestCalls.push({
        messageId,
        args,
      });
      if (messageId === 'rebuild') {
        if (mockState.rebuildError) {
          throw mockState.rebuildError;
        }
        if (mockState.rebuildPromise) {
          return await mockState.rebuildPromise;
        }
        return mockState.rebuildResult;
      }
      if (messageId === 'ensure-default-profile') {
        return mockState.defaultProfileResult;
      }
      throw new Error(`Unexpected worker message ${messageId}`);
    }),
  };
});

vi.mock(import('../src/contributions/scene/module-system.js'), () => {
  return {
    ReloadInterruptError: class ReloadInterruptError extends Error {},
  };
});

vi.mock(import('../src/contributions/scene/oms-script-runtime.js'), () => {
  return {
    OmsScriptRuntime: class OmsScriptRuntime {
      installGlobalImport() {
        mockState.installGlobalImportCalls += 1;
      }

      async reload(reason?: string) {
        mockState.reloadCalls.push(reason);
        const waiter = mockState.reloadWaiters.shift();
        if (waiter) {
          await waiter;
        }
      }

      async ensureReady(reason?: string) {
        mockState.ensureReadyCalls.push(reason);
        const waiter = mockState.ensureReadyWaiters.shift();
        if (waiter) {
          await waiter;
        }
      }
    },
  };
});

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  mockState.reloadCalls.length = 0;
  mockState.ensureReadyCalls.length = 0;
  mockState.reloadWaiters.length = 0;
  mockState.ensureReadyWaiters.length = 0;
  mockState.requestCalls.length = 0;
  mockState.loggerErrorCalls.length = 0;
  mockState.syncTaskCalls.length = 0;
  mockState.installGlobalImportCalls = 0;
  mockState.rebuildResult = {
    default: {
      ok: true,
      affectedFiles: ['src/index.ts'],
    },
  };
  mockState.defaultProfileResult = { ok: true, affectedFiles: ['src/index.ts'] };
  mockState.rebuildPromise = undefined;
  mockState.rebuildError = undefined;
  vi.stubGlobal('Editor', {
    Task: {
      __protected__: {
        addSyncTask: vi.fn((name: string, message: string) => {
          mockState.syncTaskCalls.push({
            type: 'add',
            name,
            message,
          });
        }),
        updateSyncTask: vi.fn((name: string, message: string, detail?: string) => {
          mockState.syncTaskCalls.push({
            type: 'update',
            name,
            message,
            detail,
          });
        }),
        removeSyncTask: vi.fn((name: string) => {
          mockState.syncTaskCalls.push({
            type: 'remove',
            name,
          });
        }),
      },
    },
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('asset-db OMS runtime startup', () => {
  it('shows an OMS first-build sync task while waiting for startup build', async () => {
    /// @case
    /// 1. asset-db beforePreStart waits for the OMS first build.
    /// 2. The build succeeds.
    /// @expect
    /// Vortex startup shows an independent OMS first-build task and removes it after the wait.
    const assetDb = await import('../src/contributions/asset-db/index');

    await assetDb.methods.beforePreStart({});

    expect(mockState.syncTaskCalls).toEqual([
      {
        type: 'add',
        name: 'oh-my-script:first-build',
        message: 'Building oh-my-script project scripts...',
      },
      {
        type: 'update',
        name: 'oh-my-script:first-build',
        message: 'Building oh-my-script project scripts...',
        detail: 'Waiting for first build',
      },
      {
        type: 'remove',
        name: 'oh-my-script:first-build',
      },
    ]);
  });

  it('removes the OMS first-build sync task when startup build fails', async () => {
    /// @case
    /// 1. asset-db beforePreStart waits for the OMS first build.
    /// 2. The build request throws.
    /// @expect
    /// The OMS first-build startup task is still removed so the homepage is not stuck.
    mockState.rebuildError = new Error('worker unavailable');
    const assetDb = await import('../src/contributions/asset-db/index');

    await assetDb.methods.beforePreStart({});

    expect(mockState.syncTaskCalls.at(-1)).toEqual({
      type: 'remove',
      name: 'oh-my-script:first-build',
    });
  });

  it('times out the OMS first-build wait after 120 seconds', async () => {
    /// @case
    /// 1. asset-db beforePreStart starts the OMS first build.
    /// 2. The worker rebuild request remains pending.
    /// @expect
    /// The startup task remains visible before 120 seconds and is removed after the 120-second timeout.
    vi.useFakeTimers();
    mockState.rebuildPromise = new Promise(() => undefined);
    const assetDb = await import('../src/contributions/asset-db/index');

    const beforePreStartPromise = assetDb.methods.beforePreStart({});
    await vi.advanceTimersByTimeAsync(119_999);

    expect(mockState.syncTaskCalls.at(-1)).toEqual({
      type: 'update',
      name: 'oh-my-script:first-build',
      message: 'Building oh-my-script project scripts...',
      detail: 'Waiting for first build',
    });
    expect(mockState.loggerErrorCalls).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    await beforePreStartPromise;

    expect(mockState.syncTaskCalls.at(-1)).toEqual({
      type: 'remove',
      name: 'oh-my-script:first-build',
    });
    expect(mockState.loggerErrorCalls[0]?.[1]).toMatchObject({
      message: 'oh-my-script first build timeout after 120s',
    });
  });

  it('lets afterPreStart own the first asset-db reload and accepts build reloads only after startup', async () => {
    /// @case
    /// 1. asset-db loads OMS and starts its first build in beforePreStart.
    /// 2. build success asks asset-db to reload before afterPreStart has run.
    /// 3. afterPreStart completes the startup runtime reload.
    /// 4. A later build success asks asset-db to reload after startup.
    /// @expect
    /// asset-db executes project scripts once during startup, then accepts later build-triggered reloads.
    const assetDb = await import('../src/contributions/asset-db/index');

    await assetDb.load();
    await assetDb.methods.beforePreStart({});
    await assetDb.methods.reloadRuntime('rebuild()');

    expect(mockState.requestCalls).toContainEqual({
      messageId: 'rebuild',
      args: [{
        reason: 'asset-db startup build',
        reloadAssetDbRuntime: false,
        profiles: ['default'],
      }],
    });
    expect(mockState.reloadCalls).toEqual([]);
    expect(mockState.ensureReadyCalls).toEqual([]);

    await assetDb.methods.afterPreStart({});

    expect(mockState.ensureReadyCalls).toEqual(['asset-db afterPreStart']);
    expect(mockState.reloadCalls).toEqual([]);

    await assetDb.methods.reloadRuntime('passive build');

    expect(mockState.ensureReadyCalls).toEqual(['asset-db afterPreStart']);
    expect(mockState.reloadCalls).toEqual(['passive build']);
  });

  it('defers build reloads that arrive while the startup reload is still running', async () => {
    /// @case
    /// 1. afterPreStart starts the initial asset-db runtime reload.
    /// 2. A build success asks asset-db to reload while the startup reload is still pending.
    /// 3. The startup reload finishes.
    /// @expect
    /// The in-flight startup reload is not interrupted, and one pending build reload runs afterwards.
    const startupReload = deferred<void>();
    mockState.ensureReadyWaiters.push(startupReload.promise);
    const assetDb = await import('../src/contributions/asset-db/index');

    await assetDb.load();
    await assetDb.methods.beforePreStart({});
    const afterPreStartPromise = assetDb.methods.afterPreStart({});
    await Promise.resolve();

    expect(mockState.ensureReadyCalls).toEqual(['asset-db afterPreStart']);
    expect(mockState.reloadCalls).toEqual([]);

    await assetDb.methods.reloadRuntime('passive build');

    expect(mockState.ensureReadyCalls).toEqual(['asset-db afterPreStart']);
    expect(mockState.reloadCalls).toEqual([]);

    startupReload.resolve();
    await afterPreStartPromise;

    expect(mockState.ensureReadyCalls).toEqual(['asset-db afterPreStart']);
    expect(mockState.reloadCalls).toEqual(['passive build']);
  });

  it('accepts later build reloads after a failed first build skips startup reload', async () => {
    /// @case
    /// 1. beforePreStart records a failed first build.
    /// 2. afterPreStart skips the startup project-script reload.
    /// 3. A later build success asks asset-db to reload.
    /// @expect
    /// The failed first build does not leave asset-db stuck in startup state.
    mockState.rebuildResult = {
      default: {
        ok: false,
        error: {
          message: 'first build failed',
        },
      },
    };
    const assetDb = await import('../src/contributions/asset-db/index');

    await assetDb.load();
    await assetDb.methods.beforePreStart({});
    await assetDb.methods.afterPreStart({});

    expect(mockState.reloadCalls).toEqual([]);
    expect(mockState.ensureReadyCalls).toEqual([]);

    await assetDb.methods.reloadRuntime('recovered build');

    expect(mockState.reloadCalls).toEqual(['recovered build']);
    expect(mockState.ensureReadyCalls).toEqual([]);
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
