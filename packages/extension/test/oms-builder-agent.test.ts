import cp from 'node:child_process';
import EventEmitter from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  InvocationDirection,
  type BuildProfileId,
  type BuildProfileResult as ProtocolBuildProfileResult,
  type BuildProfileResults as ProtocolBuildResults,
  type InvocationMessage,
  type PassiveBuildEndInfo,
  type PassiveProfileBuildEndInfo,
  type RebuildOptions as ProtocolRebuildOptions,
} from '@oms/build-core/protocol';
import { OmsBuilderAgent } from '../src/worker/oms-builder-agent';
import { type logger } from '../src/logger.js';

const originalProcessVersionsDescriptor = Object.getOwnPropertyDescriptor(process, 'versions')!;
const originalProcessExecPathDescriptor = Object.getOwnPropertyDescriptor(process, 'execPath')!;

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
    Profile: {
      getProject: vi.fn(async () => true),
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

afterEach(() => {
  Object.defineProperty(process, 'versions', originalProcessVersionsDescriptor);
  Object.defineProperty(process, 'execPath', originalProcessExecPathDescriptor);
});

describe('OMS builder agent process selection', () => {
  it('uses the current Electron executable as Node when its embedded Node is supported', async () => {
    /// @case
    /// 1. The extension worker is running in Electron 42 with embedded Node 24.18.
    /// 2. OMS builder setup is requested.
    /// @expect
    /// The extension marks both RunAsNode commands as Chromium child processes, proves the capability, then starts the builder through the current Electron executable.
    stubHostRuntime({
      electron: '42.6.0',
      node: '24.18.0',
      execPath: 'C:\\Vortex\\Vortex.exe',
    });
    const child = makeSuccessfulBuilderProcess();
    const spawn = vi.spyOn(cp, 'spawn').mockImplementation((() => {
      child.bootstrap();
      return child;
    }) as typeof cp.spawn);
    const execFile = mockRuntimeExecFile({
      runAsNode: {
        error: null,
        stdout: runAsNodeProbeOutput('42.6.0', '24.18.0'),
      },
    });
    const agent = new OmsBuilderAgent();

    await expect(agent.ensureDefaultProfile()).resolves.toEqual({
      ok: true,
      affectedFiles: [],
    });

    expect(Editor.Profile.getProject).toHaveBeenCalledWith(
      'oh-my-script',
      'builder.useElectronRunAsNode',
    );
    expect(execFile).toHaveBeenCalledOnce();
    expect(execFile).toHaveBeenCalledWith(
      'C:\\Vortex\\Vortex.exe',
      [
        expect.stringMatching(/[\\/]dist[\\/]worker[\\/]run-as-node-probe\.cjs$/),
        '--type=magic-param-for-sandboxie-workaround',
      ],
      expect.objectContaining({
        encoding: 'utf8',
        env: expect.objectContaining({
          ELECTRON_RUN_AS_NODE: '1',
        }),
        timeout: 3_000,
      }),
      expect.any(Function),
    );
    expect(spawn).toHaveBeenCalledWith(
      'C:\\Vortex\\Vortex.exe',
      [
        '--inspect-publish-uid=http',
        '--inspect',
        expect.any(String),
        '--type=magic-param-for-sandboxie-workaround',
      ],
      expect.objectContaining({
        stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'ipc'],
        env: expect.objectContaining({
          ELECTRON_RUN_AS_NODE: '1',
        }),
      }),
    );

    await agent.close();
  });

  it('uses external Node without probing Electron when RunAsNode is disabled for the project', async () => {
    /// @case
    /// 1. The project disables Electron RunAsNode while Electron embeds a supported Node version.
    /// 2. PATH resolves to a supported external Node.
    /// @expect
    /// The extension skips the Electron probe and starts the builder with external Node.
    vi.mocked(Editor.Profile.getProject).mockResolvedValue(false);
    stubHostRuntime({
      electron: '42.6.0',
      node: '24.18.0',
      execPath: 'C:\\Vortex\\Vortex.exe',
    });
    const child = makeSuccessfulBuilderProcess();
    const spawn = vi.spyOn(cp, 'spawn').mockImplementation((() => {
      child.bootstrap();
      return child;
    }) as typeof cp.spawn);
    const execFile = mockExternalNodeVersion('v24.0.0');
    const agent = new OmsBuilderAgent();

    await expect(agent.ensureDefaultProfile()).resolves.toEqual({
      ok: true,
      affectedFiles: [],
    });

    expect(execFile.mock.calls.map((call) => call.slice(0, 2))).toEqual([
      ['node', ['-v']],
    ]);
    expect(spawn.mock.calls[0]?.[0]).toBe('node');
    await agent.close();
  });

  it('reports the disabled project setting when external Node is unavailable', async () => {
    /// @case
    /// 1. The project disables Electron RunAsNode.
    /// 2. PATH does not provide a node executable.
    /// @expect
    /// Setup fails before spawning and reports the project policy, external failure, and required range.
    vi.mocked(Editor.Profile.getProject).mockResolvedValue(false);
    stubHostRuntime({
      electron: '42.6.0',
      node: '24.18.0',
      execPath: 'C:\\Vortex\\Vortex.exe',
    });
    vi.spyOn(cp, 'execFile').mockImplementation(((...args: unknown[]) => {
      const callback = args.at(-1) as (error: Error, stdout: string, stderr: string) => void;
      const error = Object.assign(new Error('spawn node ENOENT'), { code: 'ENOENT' });
      queueMicrotask(() => callback(error, '', ''));
      return new EventEmitter() as cp.ChildProcess;
    }) as typeof cp.execFile);
    const spawn = vi.spyOn(cp, 'spawn');
    const agent = new OmsBuilderAgent();

    await expect(agent.ensureDefaultProfile()).rejects.toThrow(
      /RunAsNode is disabled by project setting.*external Node.*ENOENT.*required Node version.*\^20\.19\.0 \|\| >=22\.12\.0/is,
    );
    expect(spawn).not.toHaveBeenCalled();
  });

  it('keeps the running builder and reads a changed project setting on restart', async () => {
    /// @case
    /// 1. The builder starts through Electron while the project setting is enabled.
    /// 2. The setting is disabled while that builder is still running.
    /// 3. The existing builder is used once more, then manually restarted.
    /// @expect
    /// The setting change does not restart the process; restart reads the new value and switches to external Node.
    let runAsNodeEnabled = true;
    vi.mocked(Editor.Profile.getProject).mockImplementation(async () => runAsNodeEnabled);
    stubHostRuntime({
      electron: '42.6.0',
      node: '24.18.0',
      execPath: 'C:\\Vortex\\Vortex.exe',
    });
    const electronChild = makeSuccessfulBuilderProcess();
    const nodeChild = makeSuccessfulBuilderProcess();
    const children = [electronChild, nodeChild];
    const spawn = vi.spyOn(cp, 'spawn').mockImplementation((() => {
      const child = children.shift();
      if (!child) {
        throw new Error('Unexpected builder process start');
      }
      child.bootstrap();
      return child;
    }) as typeof cp.spawn);
    const execFile = mockRuntimeExecFile({
      runAsNode: {
        error: null,
        stdout: runAsNodeProbeOutput('42.6.0', '24.18.0'),
      },
      externalNode: {
        error: null,
        stdout: 'v24.0.0',
      },
    });
    const agent = new OmsBuilderAgent();

    await agent.ensureDefaultProfile();
    runAsNodeEnabled = false;
    await agent.ensureDefaultProfile();

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(Editor.Profile.getProject).toHaveBeenCalledTimes(1);

    await agent.restart();

    expect(Editor.Profile.getProject).toHaveBeenCalledTimes(2);
    expect(execFile.mock.calls.map((call) => call.slice(0, 2))).toEqual([
      [
        'C:\\Vortex\\Vortex.exe',
        [
          expect.stringMatching(/run-as-node-probe\.cjs$/),
          '--type=magic-param-for-sandboxie-workaround',
        ],
      ],
      ['node', ['-v']],
    ]);
    expect(spawn.mock.calls.map(([executable]) => executable)).toEqual([
      'C:\\Vortex\\Vortex.exe',
      'node',
    ]);
    await agent.close();
  });

  it.each([
    {
      name: 'cannot be spawned',
      result: {
        error: Object.assign(new Error('spawn Vortex ENOENT'), { code: 'ENOENT' }),
        stdout: '',
      },
    },
    {
      name: 'times out',
      result: {
        error: Object.assign(new Error('Command timed out'), { killed: true, signal: 'SIGTERM' }),
        stdout: '',
      },
    },
    {
      name: 'exits unsuccessfully',
      result: {
        error: Object.assign(new Error('Command failed with exit code 9'), { code: 9 }),
        stdout: '',
      },
    },
    {
      name: 'returns unexpected output',
      result: {
        error: null,
        stdout: 'Vortex application output',
      },
    },
  ])('uses external Node when the RunAsNode probe $name', async ({ result }) => {
    /// @case
    /// 1. Electron embeds a supported Node version, but its RunAsNode probe does not prove script execution.
    /// 2. PATH resolves to a supported external Node.
    /// @expect
    /// The extension rejects the Electron candidate and starts the builder with external Node.
    stubHostRuntime({
      electron: '42.6.0',
      node: '24.18.0',
      execPath: 'C:\\Vortex\\Vortex.exe',
    });
    const child = makeSuccessfulBuilderProcess();
    const spawn = vi.spyOn(cp, 'spawn').mockImplementation((() => {
      child.bootstrap();
      return child;
    }) as typeof cp.spawn);
    const execFile = mockRuntimeExecFile({
      runAsNode: result,
      externalNode: {
        error: null,
        stdout: 'v24.0.0',
      },
    });
    const agent = new OmsBuilderAgent();

    await expect(agent.ensureDefaultProfile()).resolves.toEqual({
      ok: true,
      affectedFiles: [],
    });

    expect(execFile.mock.calls.map((call) => call.slice(0, 2))).toEqual([
      [
        'C:\\Vortex\\Vortex.exe',
        [
          expect.stringMatching(/run-as-node-probe\.cjs$/),
          '--type=magic-param-for-sandboxie-workaround',
        ],
      ],
      ['node', ['-v']],
    ]);
    expect(spawn.mock.calls[0]?.[0]).toBe('node');
    await agent.close();
  });

  it('reports the RunAsNode probe failure when external Node is unavailable', async () => {
    /// @case
    /// 1. Electron embeds a supported Node version, but the probe output does not match.
    /// 2. PATH does not provide a node executable.
    /// @expect
    /// Setup fails before spawning and reports the embedded runtime, probe result, external failure, and required range.
    stubHostRuntime({
      electron: '42.6.0',
      node: '24.18.0',
      execPath: 'C:\\Vortex\\Vortex.exe',
    });
    mockRuntimeExecFile({
      runAsNode: {
        error: null,
        stdout: 'not-the-probe',
      },
      externalNode: {
        error: Object.assign(new Error('spawn node ENOENT'), { code: 'ENOENT' }),
        stdout: '',
      },
    });
    const spawn = vi.spyOn(cp, 'spawn');
    const agent = new OmsBuilderAgent();

    await expect(agent.ensureDefaultProfile()).rejects.toThrow(
      /Electron 42\.6\.0.*supported Node 24\.18\.0.*RunAsNode probe failed.*not-the-probe.*external Node.*ENOENT.*required Node version.*\^20\.19\.0 \|\| >=22\.12\.0/is,
    );
    expect(spawn).not.toHaveBeenCalled();
  });

  it('uses a supported external Node when the Electron embedded Node is too old', async () => {
    /// @case
    /// 1. The extension worker is running in Electron 31 with embedded Node 20.15.
    /// 2. PATH resolves to a supported Node 24 runtime.
    /// @expect
    /// The extension verifies the external version and starts the builder with node.
    stubHostRuntime({
      electron: '31.3.1',
      node: '20.15.1',
      execPath: 'C:\\Creator\\Creator.exe',
    });
    const child = makeSuccessfulBuilderProcess();
    const spawn = vi.spyOn(cp, 'spawn').mockImplementation((() => {
      child.bootstrap();
      return child;
    }) as typeof cp.spawn);
    const execFile = mockExternalNodeVersion('v24.0.0');
    const agent = new OmsBuilderAgent();

    await expect(agent.ensureDefaultProfile()).resolves.toEqual({
      ok: true,
      affectedFiles: [],
    });

    expect(execFile.mock.calls[0]?.slice(0, 2)).toEqual(['node', ['-v']]);
    expect(spawn.mock.calls[0]?.[0]).toBe('node');

    await agent.close();
  });

  it('reports both runtimes when neither Node version is supported', async () => {
    /// @case
    /// 1. Electron embeds Node 20.15, below the OMS builder requirement.
    /// 2. PATH resolves to Node 20.18, which is also below the requirement.
    /// @expect
    /// Setup fails before spawning the builder and explains the required range and both detected runtimes.
    stubHostRuntime({
      electron: '31.3.1',
      node: '20.15.1',
      execPath: 'C:\\Creator\\Creator.exe',
    });
    mockExternalNodeVersion('v20.18.0');
    const spawn = vi.spyOn(cp, 'spawn');
    const agent = new OmsBuilderAgent();

    await expect(agent.ensureDefaultProfile()).rejects.toThrow(
      /Electron 31\.3\.1.*Node 20\.15\.1.*\^20\.19\.0 \|\| >=22\.12\.0.*external Node 20\.18\.0/is,
    );
    expect(spawn).not.toHaveBeenCalled();
  });

  it('reports the embedded runtime when external Node is unavailable', async () => {
    /// @case
    /// 1. Electron embeds Node 20.15, below the OMS builder requirement.
    /// 2. PATH does not provide a node executable.
    /// @expect
    /// Setup fails before spawning the builder and reports both the embedded version and the missing external runtime.
    stubHostRuntime({
      electron: '31.3.1',
      node: '20.15.1',
      execPath: 'C:\\Creator\\Creator.exe',
    });
    vi.spyOn(cp, 'execFile').mockImplementation(((...args: unknown[]) => {
      const callback = args.at(-1) as (error: Error, stdout: string, stderr: string) => void;
      const error = Object.assign(new Error('spawn node ENOENT'), { code: 'ENOENT' });
      queueMicrotask(() => callback(error, '', ''));
      return new EventEmitter() as cp.ChildProcess;
    }) as typeof cp.execFile);
    const spawn = vi.spyOn(cp, 'spawn');
    const agent = new OmsBuilderAgent();

    await expect(agent.ensureDefaultProfile()).rejects.toThrow(
      /Electron 31\.3\.1.*Node 20\.15\.1.*external Node from PATH is unavailable.*ENOENT/is,
    );
    expect(spawn).not.toHaveBeenCalled();
  });

  it('rejects an early child exit, keeps the selected runtime, and allows setup to retry', async () => {
    /// @case
    /// 1. Electron embeds a supported Node version, but the selected builder process exits before bootstrapping.
    /// 2. Setup is requested again and the next process bootstraps normally.
    /// @expect
    /// The first setup rejects without falling back to PATH Node, and the rejected setup state is cleared for the retry.
    stubHostRuntime({
      electron: '42.6.0',
      node: '24.18.0',
      execPath: 'C:\\Vortex\\Vortex.exe',
    });
    const failedChild = makeBuilderProcess();
    const recoveredChild = makeSuccessfulBuilderProcess();
    const spawn = vi.spyOn(cp, 'spawn')
      .mockImplementationOnce((() => {
        queueMicrotask(() => failedChild.emit('exit', 1, null));
        return failedChild;
      }) as typeof cp.spawn)
      .mockImplementationOnce((() => {
        recoveredChild.bootstrap();
        return recoveredChild;
      }) as typeof cp.spawn);
    const execFile = mockRuntimeExecFile({
      runAsNode: {
        error: null,
        stdout: runAsNodeProbeOutput('42.6.0', '24.18.0'),
      },
    });
    const agent = new OmsBuilderAgent();

    await expect(agent.ensureDefaultProfile()).rejects.toThrow(/exited before bootstrap.*code 1/i);
    await expect(agent.ensureDefaultProfile()).resolves.toEqual({
      ok: true,
      affectedFiles: [],
    });

    expect(spawn).toHaveBeenCalledTimes(2);
    expect(execFile).toHaveBeenCalledTimes(2);
    expect(execFile.mock.calls.every((call) => call[0] === 'C:\\Vortex\\Vortex.exe')).toBe(true);
    await agent.close();
  }, 1_000);
});

describe('OMS builder agent default profile ensure', () => {
  it('uses the dedicated clean rebuild protocol for an explicit full rebuild', async () => {
    /// @case
    /// 1. The editor requests an explicit clean rebuild.
    /// 2. Current extension build options are synchronized before the build starts.
    /// @expect
    /// The agent invokes clean-rebuild without profile filtering and does not send an incremental rebuild request.
    const builder = setupControlledBuilder();

    const rebuildPromise = builder.agent.cleanRebuild();
    await builder.waitForCleanRebuildCalls(1);

    const buildCalls = builder.protocolCalls().filter((invocation) => {
      return invocation.direction === InvocationDirection.call
        && (invocation.method === 'update-build-options'
          || invocation.method === 'rebuild'
          || invocation.method === 'clean-rebuild');
    });
    expect(buildCalls.map((invocation) => invocation.method)).toEqual([
      'update-build-options',
      'clean-rebuild',
    ]);
    expect(buildCalls[1]?.args).toEqual({});

    builder.respondToNextRebuild(okBuild([]));
    await expect(rebuildPromise).resolves.toEqual({
      default: okBuild([]),
      headless: okBuild([]),
    });
    expect(builder.rebuildCallCount()).toBe(0);
    await builder.agent.close();
  });

  it('synchronizes build options before sending a profile-only rebuild request', async () => {
    /// @case
    /// 1. Runtime readiness starts the builder for the first time.
    /// 2. The agent has current extension build options and requests only the default profile.
    /// @expect
    /// Build options are sent through update-build-options before rebuild, and rebuild contains only profile selection.
    const builder = setupControlledBuilder();

    const ensurePromise = builder.agent.ensureDefaultProfile();
    await builder.waitForRebuildCalls(1);

    const buildCalls = builder.protocolCalls().filter((invocation) => {
      return invocation.direction === InvocationDirection.call
        && (invocation.method === 'update-build-options' || invocation.method === 'rebuild');
    });
    expect(buildCalls.map((invocation) => invocation.method)).toEqual([
      'update-build-options',
      'rebuild',
    ]);
    expect(buildCalls[0]?.args).toEqual({
      extensionBuildOptions: expect.any(Array),
    });
    expect(buildCalls[1]?.args).toEqual({
      profiles: ['default'],
    });
    expect(buildCalls[1]?.args).not.toHaveProperty('extensionBuildOptions');

    builder.respondToNextRebuild(okBuild([]));
    await expect(ensurePromise).resolves.toMatchObject({ ok: true });
    await builder.agent.close();
  });

  it('does not reuse a full-profile waiter for runtime readiness', async () => {
    /// @case
    /// 1. A normal rebuild is already running.
    /// 2. Runtime readiness asks for a build before the rebuild finishes.
    /// 3. Default succeeds, but the full-profile waiter later reports a headless failure.
    /// @expect
    /// Runtime readiness settles first, then the full rebuild's newer successful default result remains reusable despite the headless failure.
    const builder = setupControlledBuilder();

    const rebuildPromise = builder.agent.rebuild();
    await builder.waitForRebuildCalls(1);

    const ensurePromise = builder.agent.ensureDefaultProfile();
    await builder.waitForRebuildCalls(2);

    expect(builder.rebuildOptions()).toEqual([
      expect.not.objectContaining({
        profiles: expect.anything(),
      }),
      expect.objectContaining({
        profiles: ['default'],
      }),
    ]);

    builder.respondToRebuild(1, okBuild(['assets/runtime.ts']));

    await expect(ensurePromise).resolves.toEqual({
      ok: true,
      affectedFiles: ['assets/runtime.ts'],
    });
    let rebuildSettled = false;
    void rebuildPromise.finally(() => {
      rebuildSettled = true;
    });
    await Promise.resolve();
    expect(rebuildSettled).toBe(false);

    builder.respondToRebuild(0, {
      default: okBuild([]),
      headless: failedBuild('headless profile failed'),
    });
    await expect(rebuildPromise).resolves.toEqual({
      default: okBuild([]),
      headless: failedBuild('headless profile failed'),
    });
    expect(builder.rebuildCallCount()).toBe(2);

    await expect(builder.agent.ensureDefaultProfile()).resolves.toEqual({
      ok: true,
      affectedFiles: [],
    });
    expect(builder.rebuildCallCount()).toBe(2);
    await builder.agent.close();
  });

  it('reuses a pending waiter with the same profile set', async () => {
    /// @case
    /// 1. Runtime readiness has already requested the default profile.
    /// 2. A second runtime readiness request arrives before that waiter settles.
    /// @expect
    /// Both callers share one default-profile IPC request.
    const builder = setupControlledBuilder();

    const firstEnsure = builder.agent.ensureDefaultProfile();
    await builder.waitForRebuildCalls(1);
    const secondEnsure = builder.agent.ensureDefaultProfile();
    await Promise.resolve();

    expect(builder.rebuildCallCount()).toBe(1);
    builder.respondToNextRebuild(okBuild(['assets/runtime.ts']));
    await expect(Promise.all([firstEnsure, secondEnsure])).resolves.toEqual([
      {
        ok: true,
        affectedFiles: ['assets/runtime.ts'],
      },
      {
        ok: true,
        affectedFiles: ['assets/runtime.ts'],
      },
    ]);
    await builder.agent.close();
  });

  it('rejects an in-flight build on restart and uses a fresh worker', async () => {
    /// @case
    /// 1. A default-profile IPC rebuild remains pending when the builder agent restarts.
    /// 2. Restart closes the old worker and requests a full rebuild from a new worker.
    /// @expect
    /// The old caller rejects promptly, while restart does not reuse it and completes through the new worker.
    stubHostRuntime({
      electron: '42.6.0',
      node: '24.18.0',
      execPath: 'C:\\Vortex\\Vortex.exe',
    });
    const firstResponses: RebuildResponse[] = [];
    const secondResponses: RebuildResponse[] = [];
    const firstChild = makeSuccessfulBuilderProcess({
      onRebuild: (respond) => firstResponses.push(respond),
    });
    const secondChild = makeSuccessfulBuilderProcess({
      onRebuild: (respond) => secondResponses.push(respond),
    });
    const spawn = vi.spyOn(cp, 'spawn')
      .mockImplementationOnce((() => {
        firstChild.bootstrap();
        return firstChild;
      }) as typeof cp.spawn)
      .mockImplementationOnce((() => {
        secondChild.bootstrap();
        return secondChild;
      }) as typeof cp.spawn);
    mockRuntimeExecFile({
      runAsNode: {
        error: null,
        stdout: runAsNodeProbeOutput('42.6.0', '24.18.0'),
      },
    });
    const agent = new OmsBuilderAgent();

    const firstBuild = agent.ensureDefaultProfile();
    const firstBuildResult = expect(firstBuild).rejects.toThrow('Builder agent closed');
    await vi.waitFor(() => {
      expect(firstResponses).toHaveLength(1);
    });

    const restart = agent.restart();
    await vi.waitFor(() => {
      expect(secondResponses).toHaveLength(1);
    });
    secondResponses.shift()!({
      default: okBuild(['assets/restarted.ts']),
      headless: okBuild([]),
    });

    await firstBuildResult;
    await expect(restart).resolves.toBeUndefined();
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(firstChild.kill).toHaveBeenCalledOnce();
    await agent.close();
  });

  it('recovers with a fresh worker after the active worker exits', async () => {
    /// @case
    /// 1. The active worker exits while a default-profile rebuild is pending.
    /// 2. Runtime readiness is requested again after the failed caller settles.
    /// @expect
    /// The failed IPC rejects, and the next request starts and completes through a fresh worker.
    stubHostRuntime({
      electron: '42.6.0',
      node: '24.18.0',
      execPath: 'C:\\Vortex\\Vortex.exe',
    });
    const firstResponses: RebuildResponse[] = [];
    const secondResponses: RebuildResponse[] = [];
    const firstChild = makeSuccessfulBuilderProcess({
      onRebuild: (respond) => firstResponses.push(respond),
    });
    const secondChild = makeSuccessfulBuilderProcess({
      onRebuild: (respond) => secondResponses.push(respond),
    });
    const spawn = vi.spyOn(cp, 'spawn')
      .mockImplementationOnce((() => {
        firstChild.bootstrap();
        return firstChild;
      }) as typeof cp.spawn)
      .mockImplementationOnce((() => {
        secondChild.bootstrap();
        return secondChild;
      }) as typeof cp.spawn);
    mockRuntimeExecFile({
      runAsNode: {
        error: null,
        stdout: runAsNodeProbeOutput('42.6.0', '24.18.0'),
      },
    });
    const agent = new OmsBuilderAgent();

    const failedBuild = agent.ensureDefaultProfile();
    await vi.waitFor(() => {
      expect(firstResponses).toHaveLength(1);
    });
    firstChild.emit('exit', 1, null);
    await expect(failedBuild).rejects.toThrow(/OMS builder exited.*code 1/i);

    const recoveredBuild = agent.ensureDefaultProfile();
    await vi.waitFor(() => {
      expect(secondResponses).toHaveLength(1);
    });
    secondResponses.shift()!({
      default: okBuild(['assets/recovered.ts']),
    });

    await expect(recoveredBuild).resolves.toEqual({
      ok: true,
      affectedFiles: ['assets/recovered.ts'],
    });
    expect(spawn).toHaveBeenCalledTimes(2);
    await agent.close();
  });

  it('waits for a pending rebuild instead of reusing an older successful build', async () => {
    /// @case
    /// 1. Runtime readiness has a previous successful build cached.
    /// 2. A new rebuild starts and another default profile request arrives while it is pending.
    /// @expect
    /// The default profile request joins the current revision instead of returning stale cache or waiting for headless.
    const builder = setupControlledBuilder();

    const firstEnsurePromise = builder.agent.ensureDefaultProfile();
    await builder.waitForRebuildCalls(1);
    builder.respondToNextRebuild(okBuild(['assets/a.ts']));
    await expect(firstEnsurePromise).resolves.toEqual({
      ok: true,
      affectedFiles: ['assets/a.ts'],
    });

    const rebuildPromise = builder.agent.rebuild();
    await builder.waitForRebuildCalls(2);
    const ensurePromise = builder.agent.ensureDefaultProfile();
    await builder.waitForRebuildCalls(3);

    builder.respondToRebuild(1, okBuild(['assets/runtime-b.ts']));

    await expect(ensurePromise).resolves.toEqual({
      ok: true,
      affectedFiles: ['assets/runtime-b.ts'],
    });
    let rebuildSettled = false;
    void rebuildPromise.finally(() => {
      rebuildSettled = true;
    });
    await Promise.resolve();
    expect(rebuildSettled).toBe(false);

    builder.respondToRebuild(0, okBuild(['assets/full-b.ts']));
    await expect(rebuildPromise).resolves.toEqual({
      default: okBuild(['assets/full-b.ts']),
      headless: okBuild(['assets/full-b.ts']),
    });
    expect(builder.rebuildCallCount()).toBe(3);
    await builder.agent.close();
  });

  it('keeps a full rebuild waiting for every profile while a default-profile-only build is pending', async () => {
    /// @case
    /// 1. Runtime readiness starts a default-profile-only build.
    /// 2. A normal rebuild requesting every profile arrives before that build finishes.
    /// @expect
    /// The normal rebuild starts its own full-profile request and does not settle with the default-profile-only result.
    const builder = setupControlledBuilder();

    const ensurePromise = builder.agent.ensureDefaultProfile();
    await builder.waitForRebuildCalls(1);

    const rebuildPromise = builder.agent.rebuild();
    await builder.waitForRebuildCalls(2);

    expect(builder.rebuildOptions()).toEqual([
      expect.objectContaining({
        profiles: ['default'],
      }),
      expect.not.objectContaining({
        profiles: expect.anything(),
      }),
    ]);

    builder.respondToNextRebuild(okBuild(['assets/a.ts']));

    await expect(ensurePromise).resolves.toEqual({
      ok: true,
      affectedFiles: ['assets/a.ts'],
    });

    let rebuildSettled = false;
    void rebuildPromise.finally(() => {
      rebuildSettled = true;
    });
    await Promise.resolve();
    expect(rebuildSettled).toBe(false);

    builder.respondToNextRebuild(okBuild(['assets/b.ts']));
    await expect(rebuildPromise).resolves.toEqual({
      default: okBuild(['assets/b.ts']),
      headless: okBuild(['assets/b.ts']),
    });
    expect(builder.rebuildCallCount()).toBe(2);
    expect(Editor.Message.request).toHaveBeenCalledWith(
      'scene',
      'execute-scene-script',
      expect.objectContaining({ method: 'reloadScripts' }),
    );
    expect(Editor.Message.request).toHaveBeenCalledWith(
      'asset-db',
      'refresh-asset',
      'assets/b.ts',
    );
    await builder.agent.close();
  });

  it('does not run runtime side effects for a headless-only rebuild', async () => {
    /// @case
    /// 1. A caller explicitly rebuilds only the headless profile.
    /// 2. The headless output succeeds.
    /// @expect
    /// The build result is returned without reloading scene/asset-db runtimes or refreshing runtime assets.
    const builder = setupControlledBuilder();

    const rebuildPromise = builder.agent.rebuild({ profiles: ['headless'] });
    await builder.waitForRebuildCalls(1);
    expect(builder.rebuildOptions()).toEqual([
      expect.objectContaining({ profiles: ['headless'] }),
    ]);

    builder.respondToNextRebuild(okBuild([]));
    await expect(rebuildPromise).resolves.toEqual({
      headless: okBuild([]),
    });
    expect(Editor.Message.request).not.toHaveBeenCalled();
    await builder.agent.close();
  });

  it('handles a successful passive default profile when headless fails', async () => {
    /// @case
    /// 1. Runtime readiness has completed once and the worker later finishes a passive full revision.
    /// 2. The passive default profile succeeds while the headless profile fails.
    /// @expect
    /// Scene/asset-db runtimes use the successful default result and refresh its affected runtime assets.
    const builder = setupControlledBuilder();
    const initialBuild = builder.agent.ensureDefaultProfile();
    await builder.waitForRebuildCalls(1);
    builder.respondToNextRebuild(okBuild(['assets/initial.ts']));
    await initialBuild;
    vi.mocked(Editor.Message.request).mockClear();

    builder.emitPassiveBuildEnd({
      profileResults: {
        default: okBuild(['assets/runtime-updated.ts']),
        headless: failedBuild('headless passive failure'),
      },
    });
    await Promise.resolve();
    expect(Editor.Message.request).not.toHaveBeenCalled();

    builder.emitPassiveProfileBuildEnd({
      profile: 'headless',
      result: failedBuild('headless passive failure'),
    });
    await Promise.resolve();
    expect(Editor.Message.request).not.toHaveBeenCalled();

    builder.emitPassiveProfileBuildEnd({
      profile: 'default',
      result: okBuild(['assets/runtime-updated.ts']),
    });

    await vi.waitFor(() => {
      expect(Editor.Message.request).toHaveBeenCalledWith(
        'scene',
        'execute-scene-script',
        expect.objectContaining({ method: 'reloadScripts' }),
      );
      expect(Editor.Message.request).toHaveBeenCalledWith(
        'asset-db',
        'refresh-asset',
        'assets/runtime-updated.ts',
      );
    });
    await builder.agent.close();
  });

  it('handles a successful default profile when a full rebuild fails in headless', async () => {
    /// @case
    /// 1. A normal full rebuild completes default successfully but fails its headless profile.
    /// 2. The profile map reports default success and headless failure to the full-profile caller.
    /// @expect
    /// The caller receives both profile results, while the successful default result still reloads runtimes and refreshes its assets.
    const builder = setupControlledBuilder();
    const rebuildPromise = builder.agent.rebuild();
    await builder.waitForRebuildCalls(1);

    builder.respondToNextRebuild({
      default: okBuild(['assets/full-default.ts']),
      headless: failedBuild('headless full rebuild failure'),
    });

    await expect(rebuildPromise).resolves.toMatchObject({
      default: {
        ok: true,
      },
      headless: {
        ok: false,
        error: {
          message: 'headless full rebuild failure',
        },
      },
    });
    expect(Editor.Message.request).toHaveBeenCalledWith(
      'scene',
      'execute-scene-script',
      expect.objectContaining({ method: 'reloadScripts' }),
    );
    expect(Editor.Message.request).toHaveBeenCalledWith(
      'asset-db',
      'refresh-asset',
      'assets/full-default.ts',
    );
    await builder.agent.close();
  });

  it('reuses the last successful build result without handling build side effects', async () => {
    /// @case
    /// 1. A normal rebuild succeeds and records the last build result.
    /// 2. Runtime readiness is requested afterwards.
    /// @expect
    /// The default profile request returns the cached successful result without re-running build side effects.
    const builder = setupControlledBuilder();

    const rebuildPromise = builder.agent.rebuild();
    await builder.waitForRebuildCalls(1);
    builder.respondToNextRebuild(okBuild(['assets/a.ts']));
    await rebuildPromise;
    expect(builder.rebuildCallCount()).toBe(1);

    vi.mocked(Editor.Message.request).mockClear();

    await expect(builder.agent.ensureDefaultProfile()).resolves.toEqual({
      ok: true,
      affectedFiles: ['assets/a.ts'],
    });
    expect(builder.rebuildCallCount()).toBe(1);
    expect(Editor.Message.request).not.toHaveBeenCalled();
    await builder.agent.close();
  });

  it('starts default profile builds without waiting for headless output', async () => {
    /// @case
    /// 1. Runtime readiness needs to start a build because no build result is cached.
    /// 2. The project has no other pending rebuild.
    /// @expect
    /// The build request asks only for runtime/default readiness so headless output does not block runtime startup.
    const builder = setupControlledBuilder();

    const ensurePromise = builder.agent.ensureDefaultProfile();
    await builder.waitForRebuildCalls(1);

    expect(builder.rebuildOptions()).toEqual([
      expect.objectContaining({
        profiles: ['default'],
      }),
    ]);

    builder.respondToNextRebuild(okBuild(['assets/a.ts']));
    await expect(ensurePromise).resolves.toEqual({
      ok: true,
      affectedFiles: ['assets/a.ts'],
    });
    await builder.agent.close();
  });

  it('can skip startup runtime reloads without dropping asset refresh', async () => {
    /// @case
    /// 1. asset-db startup asks for a rebuild while it owns the first runtime readiness check.
    /// 2. The build succeeds with one affected file.
    /// @expect
    /// The builder refreshes affected assets without starting scene or asset-db runtime reloads outside their startup barriers.
    const builder = setupControlledBuilder();
    const request = vi.mocked(Editor.Message.request);

    const rebuildPromise = builder.agent.rebuild({
      reason: 'asset-db startup build',
      reloadAssetDbRuntime: false,
      reloadSceneRuntime: false,
    });
    await builder.waitForRebuildCalls(1);
    builder.respondToNextRebuild(okBuild(['db://assets/a']));
    await rebuildPromise;

    expect(request.mock.calls.some(([target, method, payload]) => {
      return target === 'scene'
        && method === 'execute-scene-script'
        && (payload as { method?: string } | undefined)?.method === 'reloadScripts';
    })).toBe(false);
    expect(request).toHaveBeenCalledWith('asset-db', 'refresh-asset', 'db://assets/a');
    expect(request.mock.calls.some(([target, method, payload]) => {
      return target === 'asset-db'
        && method === 'execute-script'
        && (payload as { method?: string } | undefined)?.method === 'reloadRuntime';
    })).toBe(false);
    await builder.agent.close();
  });

  it('invalidates the cached successful build when build options change', async () => {
    /// @case
    /// 1. Runtime readiness caches a successful build.
    /// 2. Extension build options change.
    /// @expect
    /// The next default profile request starts a fresh build instead of reusing the old result.
    const builder = setupControlledBuilder();

    const firstEnsurePromise = builder.agent.ensureDefaultProfile();
    await builder.waitForRebuildCalls(1);
    builder.respondToNextRebuild(okBuild(['assets/a.ts']));
    await expect(firstEnsurePromise).resolves.toEqual({
      ok: true,
      affectedFiles: ['assets/a.ts'],
    });

    type PackageListener = (pkg: Editor.Interface.PackageInfo) => void | Promise<void>;
    const packageListenerCalls = vi.mocked(Editor.Package.__protected__.on).mock.calls as unknown as Array<[string, PackageListener]>;
    const packageEnabledRegistration = packageListenerCalls.find(([eventName]) => eventName === 'enable');
    if (!packageEnabledRegistration) {
      throw new Error('Package enable listener was not registered');
    }
    await packageEnabledRegistration[1]({
      name: 'test-extension',
      path: '/__oms_test__/extensions/test-extension',
      enable: true,
      invalid: false,
    } as Editor.Interface.PackageInfo);

    const secondEnsurePromise = builder.agent.ensureDefaultProfile();
    await builder.waitForRebuildCalls(2);
    builder.respondToNextRebuild(okBuild(['assets/b.ts']));
    await expect(secondEnsurePromise).resolves.toEqual({
      ok: true,
      affectedFiles: ['assets/b.ts'],
    });
    expect(builder.rebuildCallCount()).toBe(2);
    await builder.agent.close();
  });

  it('invalidates the cached successful build when another build starts', async () => {
    /// @case
    /// 1. Runtime readiness caches a successful build.
    /// 2. The builder receives a build-start notification.
    /// @expect
    /// The next default profile request starts a fresh build instead of reusing the old result.
    const builder = setupControlledBuilder();

    const firstEnsurePromise = builder.agent.ensureDefaultProfile();
    await builder.waitForRebuildCalls(1);
    builder.respondToNextRebuild(okBuild(['assets/a.ts']));
    await expect(firstEnsurePromise).resolves.toEqual({
      ok: true,
      affectedFiles: ['assets/a.ts'],
    });

    builder.emitBuildStart();

    const secondEnsurePromise = builder.agent.ensureDefaultProfile();
    await builder.waitForRebuildCalls(2);
    builder.respondToNextRebuild(okBuild(['assets/b.ts']));
    await expect(secondEnsurePromise).resolves.toEqual({
      ok: true,
      affectedFiles: ['assets/b.ts'],
    });
    expect(builder.rebuildCallCount()).toBe(2);
    await builder.agent.close();
  });

  it('keeps cached runtime readiness across a headless-only build', async () => {
    /// @case
    /// 1. A successful default build is cached for runtime readiness.
    /// 2. The builder announces a headless-only revision.
    /// @expect
    /// Runtime readiness keeps using the cached default result without starting another default build.
    const builder = setupControlledBuilder();

    const firstEnsurePromise = builder.agent.ensureDefaultProfile();
    await builder.waitForRebuildCalls(1);
    builder.respondToNextRebuild(okBuild(['assets/runtime.ts']));
    await expect(firstEnsurePromise).resolves.toMatchObject({ ok: true });

    builder.emitBuildStart(['headless']);

    await expect(builder.agent.ensureDefaultProfile()).resolves.toEqual({
      ok: true,
      affectedFiles: ['assets/runtime.ts'],
    });
    expect(builder.rebuildCallCount()).toBe(1);
    await builder.agent.close();
  });

  it('retries default profile ensure after a failed build result', async () => {
    /// @case
    /// 1. Runtime readiness starts a build that fails.
    /// 2. Runtime readiness is requested again.
    /// @expect
    /// The failed result is not treated as usable cache, so the next ensure retries the build.
    const builder = setupControlledBuilder();

    const firstEnsurePromise = builder.agent.ensureDefaultProfile();
    await builder.waitForRebuildCalls(1);
    builder.respondToNextRebuild(failedBuild('first build failed'));
    await expect(firstEnsurePromise).resolves.toEqual({
      ok: false,
      error: {
        message: 'first build failed',
      },
    });
    const secondEnsurePromise = builder.agent.ensureDefaultProfile();
    await builder.waitForRebuildCalls(2);
    builder.respondToNextRebuild(okBuild(['assets/recovered.ts']));
    await expect(secondEnsurePromise).resolves.toEqual({
      ok: true,
      affectedFiles: ['assets/recovered.ts'],
    });

    expect(builder.rebuildCallCount()).toBe(2);
    expect(Editor.Message.request).not.toHaveBeenCalled();
    await builder.agent.close();
  });
});

function okBuild(affectedFiles: string[]): ProtocolBuildProfileResult {
  return {
    ok: true,
    affectedFiles,
  };
}

function failedBuild(message: string): ProtocolBuildProfileResult {
  return {
    ok: false,
    error: {
      message,
    },
  };
}

function setupControlledBuilder() {
  stubHostRuntime({
    electron: '42.6.0',
    node: '24.18.0',
    execPath: 'C:\\Vortex\\Vortex.exe',
  });
  const pendingRebuildResponses: Array<{
    respond: RebuildResponse;
    profiles: BuildProfileId[];
  }> = [];
  const child = makeSuccessfulBuilderProcess({
    onRebuild: (respond, profiles) => {
      pendingRebuildResponses.push({ respond, profiles });
    },
  });
  vi.spyOn(cp, 'spawn').mockImplementation((() => {
    child.bootstrap();
    return child;
  }) as typeof cp.spawn);
  mockRuntimeExecFile({
    runAsNode: {
      error: null,
      stdout: runAsNodeProbeOutput('42.6.0', '24.18.0'),
    },
  });
  const agent = new OmsBuilderAgent();
  const rebuildCallCount = () => vi.mocked(child.send).mock.calls.filter(([message]) => {
    const invocation = message as InvocationMessage;
    return invocation.direction === InvocationDirection.call && invocation.method === 'rebuild';
  }).length;
  const cleanRebuildCallCount = () => vi.mocked(child.send).mock.calls.filter(([message]) => {
    const invocation = message as InvocationMessage;
    return invocation.direction === InvocationDirection.call && invocation.method === 'clean-rebuild';
  }).length;
  const rebuildOptions = () => vi.mocked(child.send).mock.calls.flatMap(([message]) => {
    const invocation = message as InvocationMessage;
    return invocation.direction === InvocationDirection.call && invocation.method === 'rebuild'
      ? [invocation.args as ProtocolRebuildOptions]
      : [];
  });
  const protocolCalls = () => vi.mocked(child.send).mock.calls.map(([message]) => message as InvocationMessage);

  return {
    agent,
    rebuildCallCount,
    rebuildOptions,
    protocolCalls,
    waitForRebuildCalls: async (count: number) => {
      await vi.waitFor(() => {
        expect(rebuildCallCount()).toBe(count);
      });
    },
    waitForCleanRebuildCalls: async (count: number) => {
      await vi.waitFor(() => {
        expect(cleanRebuildCallCount()).toBe(count);
      });
    },
    respondToNextRebuild: (result: ProtocolBuildProfileResult | ProtocolBuildResults) => {
      const pendingResponse = pendingRebuildResponses.shift();
      if (!pendingResponse) {
        throw new Error('No pending OMS builder rebuild request');
      }
      pendingResponse.respond(toProtocolBuildResults(result, pendingResponse.profiles));
    },
    respondToRebuild: (index: number, result: ProtocolBuildProfileResult | ProtocolBuildResults) => {
      const [pendingResponse] = pendingRebuildResponses.splice(index, 1);
      if (!pendingResponse) {
        throw new Error(`No pending OMS builder rebuild request at index ${index}`);
      }
      pendingResponse.respond(toProtocolBuildResults(result, pendingResponse.profiles));
    },
    emitBuildStart: (profiles: BuildProfileId[] = ['default', 'headless']) => {
      child.emit('message', {
        direction: InvocationDirection.call,
        invocationId: 20_000,
        method: 'build-start',
        args: {
          time: Date.now(),
          profiles,
        },
      } satisfies InvocationMessage<'build-start'>);
    },
    emitPassiveBuildEnd: (info: PassiveBuildEndInfo) => {
      child.emit('message', {
        direction: InvocationDirection.call,
        invocationId: 20_001,
        method: 'passive-build-end',
        args: info,
      } satisfies InvocationMessage<'passive-build-end'>);
    },
    emitPassiveProfileBuildEnd: (info: PassiveProfileBuildEndInfo) => {
      child.emit('message', {
        direction: InvocationDirection.call,
        invocationId: 20_002,
        method: 'passive-profile-build-end',
        args: info,
      } satisfies InvocationMessage<'passive-profile-build-end'>);
    },
  };
}

function toProtocolBuildResults(
  result: ProtocolBuildProfileResult | ProtocolBuildResults,
  profiles: BuildProfileId[],
): ProtocolBuildResults {
  if (!('ok' in result)) {
    return result;
  }
  return Object.fromEntries(profiles.map((profile) => [profile, result])) as ProtocolBuildResults;
}

function stubHostRuntime(options: {
  electron: string;
  node: string;
  execPath: string;
}) {
  Object.defineProperty(process, 'versions', {
    configurable: true,
    enumerable: true,
    value: {
      ...process.versions,
      electron: options.electron,
      node: options.node,
    },
  });
  Object.defineProperty(process, 'execPath', {
    configurable: true,
    enumerable: true,
    value: options.execPath,
    writable: true,
  });
}

function runAsNodeProbeOutput(electronVersion: string, nodeVersion: string) {
  return `oms-run-as-node-probe:${electronVersion}:${nodeVersion}`;
}

function mockRuntimeExecFile(options: {
  runAsNode: MockExecFileResult;
  externalNode?: MockExecFileResult;
}) {
  return vi.spyOn(cp, 'execFile').mockImplementation(((...args: unknown[]) => {
    const executable = args[0] as string;
    const callback = args.at(-1) as (error: Error | null, stdout: string, stderr: string) => void;
    const result = executable === 'node' ? options.externalNode : options.runAsNode;
    if (!result) {
      throw new Error(`Unexpected execFile call for ${executable}`);
    }
    queueMicrotask(() => callback(result.error, result.stdout, result.stderr ?? ''));
    return new EventEmitter() as cp.ChildProcess;
  }) as typeof cp.execFile);
}

function mockExternalNodeVersion(version: string) {
  return vi.spyOn(cp, 'execFile').mockImplementation(((...args: unknown[]) => {
    const callback = args.at(-1) as (error: Error | null, stdout: string, stderr: string) => void;
    queueMicrotask(() => callback(null, version, ''));
    return new EventEmitter() as cp.ChildProcess;
  }) as typeof cp.execFile);
}

function makeSuccessfulBuilderProcess(options: BuilderProcessOptions = {}) {
  const child = makeBuilderProcess(options);
  child.bootstrap = () => {
    queueMicrotask(() => child.emit('message', {
      direction: InvocationDirection.call,
      invocationId: 10_000,
      method: 'bootstrapped',
      args: undefined,
    } satisfies InvocationMessage));
  };
  return child;
}

function makeBuilderProcess(options: BuilderProcessOptions = {}) {
  const child = new EventEmitter() as BuilderProcessStub;
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const log = new PassThrough();
  child.stdin = stdin;
  child.stdout = stdout;
  child.stderr = stderr;
  child.stdio = [stdin, stdout, stderr, log, null];
  child.connected = true;
  child.exitCode = null;
  child.signalCode = null;
  child.killed = false;
  child.spawnargs = [];
  child.spawnfile = '';
  child.kill = vi.fn(() => {
    child.killed = true;
    stdin.end();
    stdout.end();
    stderr.end();
    log.end();
    return true;
  });
  child.send = vi.fn((message: InvocationMessage) => {
    if (message.direction !== InvocationDirection.call) {
      return true;
    }
    const respond = (returnValue: ProtocolBuildResults | undefined) => {
      queueMicrotask(() => child.emit('message', {
        direction: InvocationDirection.returns,
        invocationId: message.invocationId,
        ok: true,
        returnValue,
      } satisfies InvocationMessage));
    };
    const isBuildRequest = message.method === 'rebuild' || message.method === 'clean-rebuild';
    if (isBuildRequest && options.onRebuild) {
      const profiles = (message.args as ProtocolRebuildOptions).profiles ?? ['default', 'headless'];
      options.onRebuild(respond, profiles);
      return true;
    }
    const returnValue = isBuildRequest
      ? toProtocolBuildResults(
        okBuild([]),
        (message.args as ProtocolRebuildOptions).profiles ?? ['default', 'headless'],
      )
      : undefined;
    respond(returnValue);
    return true;
  }) as BuilderProcessStub['send'];
  child.disconnect = vi.fn();
  child.ref = vi.fn();
  child.unref = vi.fn();
  child.bootstrap = () => undefined;
  return child;
}

type BuilderProcessStub = cp.ChildProcess & {
  bootstrap: () => void;
};

interface BuilderProcessOptions {
  onRebuild?: (respond: RebuildResponse, profiles: BuildProfileId[]) => void;
}

type RebuildResponse = (result: ProtocolBuildResults) => void;

interface MockExecFileResult {
  error: Error | null;
  stdout: string;
  stderr?: string;
}
