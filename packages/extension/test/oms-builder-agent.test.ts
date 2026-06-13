import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BuildResult as ProtocolBuildResult } from '@oms/build-core/protocol';
import { OmsBuilderAgent } from '../src/worker/oms-builder-agent';
import { type logger } from '../src/logger.js';

vi.mock(import('../src/logger.js'), () => {
  return {
    logger: console as unknown as typeof logger,
  };
});

beforeEach(() => {
  vi.restoreAllMocks();
  vi.stubGlobal('Editor', {
    Project: {
      path: '/__oms_test__',
      tmpDir: '/__oms_test__/temp',
    },
    Package: {
      getPackages: vi.fn(() => []),
      __protected__: {
        on: vi.fn(),
      },
    },
    Message: {
      request: vi.fn(async () => undefined),
      broadcast: vi.fn(),
      __protected__: {
        addBroadcastListener: vi.fn(),
        removeBroadcastListener: vi.fn(),
      },
    },
  });
});

describe('OMS builder agent runtime build ensure', () => {
  it('waits for a pending rebuild instead of starting another build', async () => {
    /// @case
    /// 1. A normal rebuild is already running.
    /// 2. Runtime readiness asks for a build before the rebuild finishes.
    /// @expect
    /// The runtime ensure waits for the pending rebuild instead of starting a second build.
    const build = deferred<ProtocolBuildResult>();
    const { agent, runRebuild } = makeAgent(() => build.promise);

    const rebuildPromise = agent.rebuild();
    await Promise.resolve();

    const ensurePromise = agent.ensureRuntimeBuild();
    await Promise.resolve();

    expect(runRebuild).toHaveBeenCalledTimes(1);

    build.resolve(okBuild(['assets/a.ts']));

    await expect(ensurePromise).resolves.toEqual({
      ok: true,
      beginningModules: ['assets/a.ts'],
    });
    await expect(rebuildPromise).resolves.toEqual({
      ok: true,
      beginningModules: ['assets/a.ts'],
    });
    expect(runRebuild).toHaveBeenCalledTimes(1);
  });

  it('waits for a pending rebuild instead of reusing an older successful build', async () => {
    /// @case
    /// 1. Runtime readiness has a previous successful build cached.
    /// 2. A new rebuild starts and another runtime ensure arrives while it is pending.
    /// @expect
    /// The runtime ensure waits for the newer pending rebuild instead of returning the stale cached result.
    const pendingBuild = deferred<ProtocolBuildResult>();
    const { agent, runRebuild } = makeAgent(vi.fn()
      .mockResolvedValueOnce(okBuild(['assets/a.ts']))
      .mockReturnValueOnce(pendingBuild.promise));

    await expect(agent.ensureRuntimeBuild()).resolves.toEqual({
      ok: true,
      beginningModules: ['assets/a.ts'],
    });

    const rebuildPromise = agent.rebuild();
    await Promise.resolve();
    const ensurePromise = agent.ensureRuntimeBuild();
    await Promise.resolve();

    pendingBuild.resolve(okBuild(['assets/b.ts']));

    await expect(rebuildPromise).resolves.toEqual({
      ok: true,
      beginningModules: ['assets/b.ts'],
    });
    await expect(ensurePromise).resolves.toEqual({
      ok: true,
      beginningModules: ['assets/b.ts'],
    });
    expect(runRebuild).toHaveBeenCalledTimes(2);
  });

  it('lets rebuild wait for a pending runtime ensure build and handle its result', async () => {
    /// @case
    /// 1. Runtime readiness starts a build.
    /// 2. A normal rebuild request arrives before that build finishes.
    /// @expect
    /// The rebuild waits for the pending ensure build and still runs normal build side effects once.
    const build = deferred<ProtocolBuildResult>();
    const { agent, runRebuild, handleBuildResult } = makeAgent(() => build.promise);

    const ensurePromise = agent.ensureRuntimeBuild();
    await Promise.resolve();

    const rebuildPromise = agent.rebuild();
    await Promise.resolve();

    expect(runRebuild).toHaveBeenCalledTimes(1);

    build.resolve(okBuild(['assets/a.ts']));

    await expect(ensurePromise).resolves.toEqual({
      ok: true,
      beginningModules: ['assets/a.ts'],
    });
    await expect(rebuildPromise).resolves.toEqual({
      ok: true,
      beginningModules: ['assets/a.ts'],
    });
    expect(runRebuild).toHaveBeenCalledTimes(1);
    expect(handleBuildResult).toHaveBeenCalledTimes(1);
  });

  it('reuses the last successful build result without handling build side effects', async () => {
    /// @case
    /// 1. A normal rebuild succeeds and records the last build result.
    /// 2. Runtime readiness is requested afterwards.
    /// @expect
    /// The runtime ensure returns the cached successful build without re-running build side effects.
    const { agent, runRebuild, handleBuildResult } = makeAgent(async () => okBuild(['assets/a.ts']));

    await agent.rebuild();
    expect(runRebuild).toHaveBeenCalledTimes(1);
    expect(handleBuildResult).toHaveBeenCalledTimes(1);

    handleBuildResult.mockClear();

    await expect(agent.ensureRuntimeBuild()).resolves.toEqual({
      ok: true,
      beginningModules: ['assets/a.ts'],
    });
    expect(runRebuild).toHaveBeenCalledTimes(1);
    expect(handleBuildResult).not.toHaveBeenCalled();
  });

  it('can skip asset-db runtime reload for startup rebuild without dropping other side effects', async () => {
    /// @case
    /// 1. asset-db startup asks for a rebuild while it owns the first runtime readiness check.
    /// 2. The build succeeds with one affected file.
    /// @expect
    /// The builder reloads scene scripts and refreshes affected assets, but does not ask asset-db to reload its runtime.
    const agent = new OmsBuilderAgent();
    const agentInternals = getAgentInternals(agent);
    agentInternals._runRebuild = vi.fn(async () => okBuild(['db://assets/a']));
    const request = vi.mocked(Editor.Message.request);

    await agent.rebuild({
      reason: 'asset-db startup build',
      reloadAssetDbRuntime: false,
    });

    expect(request).toHaveBeenCalledWith('scene', 'execute-scene-script', expect.objectContaining({
      method: 'reloadScripts',
      args: ['asset-db startup build'],
    }));
    expect(request).toHaveBeenCalledWith('asset-db', 'refresh-asset', 'db://assets/a');
    expect(request.mock.calls.some(([target, method, payload]) => {
      return target === 'asset-db'
        && method === 'execute-script'
        && (payload as { method?: string } | undefined)?.method === 'reloadRuntime';
    })).toBe(false);
  });

  it('invalidates the cached successful build when build options change', async () => {
    /// @case
    /// 1. Runtime readiness caches a successful build.
    /// 2. Extension build options change.
    /// @expect
    /// The next runtime ensure starts a fresh build instead of reusing the old result.
    const { agent, runRebuild } = makeAgent(vi.fn()
      .mockResolvedValueOnce(okBuild(['assets/a.ts']))
      .mockResolvedValueOnce(okBuild(['assets/b.ts'])));

    await expect(agent.ensureRuntimeBuild()).resolves.toEqual({
      ok: true,
      beginningModules: ['assets/a.ts'],
    });

    await getAgentInternals(agent)._updateBuildOptions();

    await expect(agent.ensureRuntimeBuild()).resolves.toEqual({
      ok: true,
      beginningModules: ['assets/b.ts'],
    });
    expect(runRebuild).toHaveBeenCalledTimes(2);
  });

  it('invalidates the cached successful build when another build starts', async () => {
    /// @case
    /// 1. Runtime readiness caches a successful build.
    /// 2. The builder receives a build-start notification.
    /// @expect
    /// The next runtime ensure starts a fresh build instead of reusing the old result.
    const { agent, runRebuild } = makeAgent(vi.fn()
      .mockResolvedValueOnce(okBuild(['assets/a.ts']))
      .mockResolvedValueOnce(okBuild(['assets/b.ts'])));

    await expect(agent.ensureRuntimeBuild()).resolves.toEqual({
      ok: true,
      beginningModules: ['assets/a.ts'],
    });

    getAgentInternals(agent)._handleBuildStart();

    await expect(agent.ensureRuntimeBuild()).resolves.toEqual({
      ok: true,
      beginningModules: ['assets/b.ts'],
    });
    expect(runRebuild).toHaveBeenCalledTimes(2);
  });

  it('retries runtime ensure after a failed build result', async () => {
    /// @case
    /// 1. Runtime readiness starts a build that fails.
    /// 2. Runtime readiness is requested again.
    /// @expect
    /// The failed result is not treated as usable cache, so the next ensure retries the build.
    const { agent, runRebuild, handleBuildResult } = makeAgent(vi.fn()
      .mockResolvedValueOnce(failedBuild('first build failed'))
      .mockResolvedValueOnce(okBuild(['assets/recovered.ts'])));

    await expect(agent.ensureRuntimeBuild()).resolves.toEqual({
      ok: false,
      error: {
        message: 'first build failed',
      },
    });
    await expect(agent.ensureRuntimeBuild()).resolves.toEqual({
      ok: true,
      beginningModules: ['assets/recovered.ts'],
    });

    expect(runRebuild).toHaveBeenCalledTimes(2);
    expect(handleBuildResult).not.toHaveBeenCalled();
  });
});

function makeAgent(runRebuildImpl: () => Promise<ProtocolBuildResult>) {
  const agent = new OmsBuilderAgent();
  const agentInternals = getAgentInternals(agent);
  agentInternals._runRebuild = vi.fn(runRebuildImpl);
  agentInternals._handleBuildResult = vi.fn(async () => undefined);
  return {
    agent,
    runRebuild: agentInternals._runRebuild,
    handleBuildResult: agentInternals._handleBuildResult,
  };
}

function getAgentInternals(agent: OmsBuilderAgent) {
  return agent as unknown as {
    _runRebuild: ReturnType<typeof vi.fn<() => Promise<ProtocolBuildResult>>>;
    _handleBuildResult: ReturnType<typeof vi.fn<(
      buildResult: ProtocolBuildResult,
      reason: string,
      opts?: { reloadAssetDbRuntime?: boolean },
    ) => Promise<void>>>;
    _updateBuildOptions: () => Promise<void>;
    _handleBuildStart: () => void;
  };
}

function okBuild(affectedFiles: string[]): ProtocolBuildResult {
  return {
    ok: true,
    affectedFiles,
  };
}

function failedBuild(message: string): ProtocolBuildResult {
  return {
    ok: false,
    error: {
      message,
    },
  };
}

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
