import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BuildResult } from '../src/worker/worker-message-descriptions';

const mockState = vi.hoisted(() => {
  return {
    reloadCalls: [] as Array<string | undefined>,
    ensureReadyCalls: [] as Array<string | undefined>,
    reloadWaiters: [] as Array<Promise<void>>,
    ensureReadyWaiters: [] as Array<Promise<void>>,
    requestCalls: [] as Array<{ messageId: string; args: unknown[] }>,
    installGlobalImportCalls: 0,
    rebuildResult: { ok: true, beginningModules: ['src/index.ts'] } as BuildResult,
  };
});

vi.mock(import('../src/logger.js'), () => {
  return {
    logger: {
      debug: vi.fn(),
      error: vi.fn(),
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
        return mockState.rebuildResult;
      }
      if (messageId === 'ensure-runtime-build') {
        return mockState.rebuildResult;
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
  vi.clearAllMocks();
  mockState.reloadCalls.length = 0;
  mockState.ensureReadyCalls.length = 0;
  mockState.reloadWaiters.length = 0;
  mockState.ensureReadyWaiters.length = 0;
  mockState.requestCalls.length = 0;
  mockState.installGlobalImportCalls = 0;
  mockState.rebuildResult = {
    ok: true,
    beginningModules: ['src/index.ts'],
  };
});

describe('asset-db OMS runtime startup', () => {
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
      ok: false,
      error: {
        message: 'first build failed',
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
