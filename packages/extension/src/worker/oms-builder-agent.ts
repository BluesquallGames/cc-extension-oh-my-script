import cp from 'node:child_process';
import { logger } from '../logger.js';
import { Ipc, type InvocationMessage, type ClientInvocationMethodId, type ServerInvocationMethodId, setLogger, type BuildOptions, type ExtensionBuildOptions, BuildResult as ProtocolBuildResult } from '@oms/build-core/protocol';
import { addEditorBroadcastListener } from '../utils/editor/common.js';
import { addListenerOnPackageEnabled, addListenerOnPackageDisabled } from '../utils/editor/extension.js';
import type { BuildResult, RebuildOptions } from './worker-message-descriptions.js';
import { setTimeout } from 'node:timers/promises';
import EventEmitter from 'node:events';
import { broadcastInner, InnerPackageMessageId } from '../inner-package-messaging.js';
import { selfExtensionName, selfPackageName, selfPackagePath } from '../self-info.js';
import { SceneMethods } from '../contributions/scene/index.js';
import { createInterface } from 'node:readline/promises';
import { resolve } from 'node:path';
import { clean as cleanSemver, satisfies as satisfiesSemver } from 'semver';
import { promiseWithResolvers } from '../utils/promise-with-resolvers.js';

setLogger(logger);

const logTag = '[BuilderAgent] ';
// Matches the strictest Node engine requirement among build-core runtime dependencies: oxc-transform@0.135.0.
const supportedNodeVersionRange = '^20.19.0 || >=22.12.0';
const runAsNodeProbeTimeoutMs = 3_000;
// Sandboxie Plus 1.18.0 injects its default Chromium compatibility flag,
// `--disable-features=PrintCompositorLPAC`, into processes classified as Chrome. That includes Electron
// when mapped through `SpecialImage=chrome`; see https://sandboxie-plus.com/sandboxie/customchromiumflags/.
// ELECTRON_RUN_AS_NODE turns Electron into plain Node, which rejects that Chromium-only option and exits
// before running the entry script. Sandboxie skips the injection when the command line contains " --type=".
// Keep this deliberately nonstandard marker after the entry script: Sandboxie can see it, while RunAsNode
// passes it to the script instead of parsing it as a Node option.
const sandboxieRunAsNodeProcessTypeArg = '--type=magic-param-for-sandboxie-workaround';

export class OmsBuilderAgent extends EventEmitter<{
  setup: [];
}> {
  constructor() {
    super();
    addEditorBroadcastListener('asset-db:ready', () => {
      logger.debug(`Asset DB ready`);
    });

    addListenerOnPackageEnabled(async (pkg: Editor.Interface.PackageInfo) => {
      logger.debug(`Package enabled: ${pkg.name}`);
      if (!this._filterPackage(pkg)) {
        return;
      }
      await this._updateBuildOptions();
    });

    addListenerOnPackageDisabled(async (pkg: Editor.Interface.PackageInfo) => {
      logger.debug(`Package disabled: ${pkg.name}`);
      if (!this._filterPackage(pkg)) {
        return;
      }
      await this._updateBuildOptions();
    });
  }

  async close() {
    switch (this._state.type) {
    case StateType.closing:
    case StateType.closed:
      return;
    }

    this._state = { type: StateType.closing };
    if (this._setupPromise) {
      const setupPromise = this._setupPromise;
      this._setupPromise = undefined;
      try {
        const serverAgent = await setupPromise;
        serverAgent.childProcess.kill();
      } catch (err) {
        logger.error(`${logTag}close builder agent failed: ${err}`);
      } finally {
        this._state = { type: StateType.closed };
      }
    }
  }

  async rebuild(opts: RebuildOptions = {}): Promise<BuildResult> {
    const reason = opts.reason ?? 'rebuild()';
    const t0 = Date.now();
    const rebuildResult = await this._getOrStartBuild();
    logger.debug(`${logTag}Rebuild ok in ${Date.now() - t0}ms, let's handle the result`);
    await this._handleBuildResult(rebuildResult, reason, {
      reloadAssetDbRuntime: opts.reloadAssetDbRuntime ?? true,
    });
    logger.info(`${logTag}Rebuild done in ${Date.now() - t0}ms`);
    return this._toWorkerBuildResult(rebuildResult);
  }

  async ensureRuntimeBuild(): Promise<BuildResult> {
    const t0 = Date.now();
    const rebuildResult = await this._ensureRuntimeBuildResult();
    logger.info(`${logTag}Runtime build ensured in ${Date.now() - t0}ms`);
    return this._toWorkerBuildResult(rebuildResult);
  }

  private async _ensureRuntimeBuildResult(): Promise<ProtocolBuildResult> {
    if (this._currentBuildPromise) {
      return await this._currentBuildPromise;
    }
    if (this._lastBuildResult?.ok) {
      return this._lastBuildResult;
    }
    return await this._getOrStartBuild();
  }

  private async _getOrStartBuild(): Promise<ProtocolBuildResult> {
    if (this._currentBuildPromise) {
      return await this._currentBuildPromise;
    }
    return await this._runTrackedRebuild();
  }

  private _runTrackedRebuild(): Promise<ProtocolBuildResult> {
    const buildPromise = this._runRebuild().then((buildResult) => {
      this._rememberBuildResult(buildResult);
      return buildResult;
    }).finally(() => {
      if (this._currentBuildPromise === buildPromise) {
        this._currentBuildPromise = undefined;
      }
    });
    this._currentBuildPromise = buildPromise;
    return buildPromise;
  }

  private async _runRebuild(): Promise<ProtocolBuildResult> {
    switch (this._state.type) {
    case StateType.closing:
      throw new Error(`${logTag} is closing`);
    }

    const serverAgent = await this._setup();
    const buildOptions = await this._makeBuildOptions();
    logger.debug(`${logTag}Rebuild with options: %o`, buildOptions);
    return await serverAgent.ipc.invoke('rebuild', buildOptions);
  }

  async restart() {
    await this.close();
    await this.rebuild();
  }

  async inlineUUIDs() {
    switch (this._state.type) {
    case StateType.closing:
      logger.error(`${logTag} is not opened`);
      return;
    }

    const serverAgent = await this._setup();
    await serverAgent.ipc.invoke('inline-uuids', undefined);
  }

  async buildProd(opts: {
    buildDir: string;
    debug: boolean;
    sourceMaps: boolean | 'inline';
    platform: string;
    headless?: boolean;
  }) {
    switch (this._state.type) {
    case StateType.closing:
      logger.error(`${logTag} is not opened`);
      return;
    }

    const serverAgent = await this._setup();
    await serverAgent.ipc.invoke('build-prod', { ...opts, headless: opts.headless ?? false });
  }

  private _state: {
    type: StateType.closed | StateType.opening | StateType.closing;
  } | {
    type: StateType.opened;
    serverAgent: ServerAgent;
  } = {
      type: StateType.closed,
    };

  private _setupPromise: Promise<ServerAgent> | undefined = undefined;
  private _currentBuildPromise: Promise<ProtocolBuildResult> | undefined = undefined;
  private _lastBuildResult: ProtocolBuildResult | undefined = undefined;
  private _pingPongDuration = 5;
  private _pongReceived = false;

  private _startPingPong(serverAgent: ServerAgent) {
    return;
    serverAgent.ipc.invoke('ping', undefined).catch((err) => {
      logger.error(`${logTag}OMS builder ping failed: %o`, err);
    });
    void setTimeout(this._pingPongDuration * 1000).then(() => this._onPingFrame());
  }

  private async _onPingFrame() {
    switch (this._state.type) {
    case StateType.closing:
    case StateType.closed:
    case StateType.opening:
      return;
    }
    /// asserts(this._state === State.opened);
    const pongReceived = this._pongReceived;
    this._pongReceived = false;
    if (pongReceived) {
      this._startPingPong(this._state.serverAgent);
      return;
    }
    logger.error(`${logTag}OMS builder no response after ${this._pingPongDuration}s, will restart.`);
    await this.close();
    await this.restart();
  }

  private async _setup() {
    if (!this._setupPromise) {
      this._state = { type: StateType.opening };
      this._setupPromise = this._doSetup().then((serverAgent) => {
        this._state = { type: StateType.opened, serverAgent };
        this._startPingPong(serverAgent);
        this.emit('setup');
        return serverAgent;
      }).catch((err) => {
        this._setupPromise = undefined;
        this._state = { type: StateType.closed };
        throw err;
      });
    }
    return this._setupPromise;
  }

  private async _doSetup(): Promise<ServerAgent> {
    const setupStart = Date.now();
    logger.debug(`${logTag}Setup OMS builder`);
    const runtime = await this._selectBuilderRuntime();
    const main = require.resolve('@oms/build-core/main');
    const workerLogFd = 3;
    const spawnStart = Date.now();

    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      OMS_BUILDER_CORE_LOG_FD: `${workerLogFd}`,
      OMS_PACKAGE_ROOT: selfPackagePath,
    };
    if (runtime.runElectronAsNode) {
      childEnv.ELECTRON_RUN_AS_NODE = '1';
    }

    const childArgs = ['--inspect-publish-uid=http', '--inspect', main];
    if (runtime.runElectronAsNode) {
      childArgs.push(sandboxieRunAsNodeProcessTypeArg);
    }

    logger.info(`${logTag}Starting OMS builder with ${runtime.description}`);
    const childProcess = cp.spawn(runtime.executable, childArgs, {
      stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'ipc'],
      env: childEnv,
    });

    const {
      promise: processAbortedPromise,
      reject: rejectProcessAborted,
    } = promiseWithResolvers<never>();
    const onProcessError = (error: Error) => {
      rejectProcessAborted(new Error(
        `${logTag}OMS builder using ${runtime.description} failed before bootstrap setup completed: ${error.message}`,
      ));
    };
    const onProcessExit = (code: number | null, signal: NodeJS.Signals | null) => {
      rejectProcessAborted(new Error(
        `${logTag}OMS builder using ${runtime.description} exited before bootstrap setup completed (code ${code ?? 'unknown'}, signal ${signal ?? 'none'})`,
      ));
    };
    childProcess.once('error', onProcessError);
    childProcess.once('exit', onProcessExit);

    if (childProcess.stdout) {
      (async () => {
        for await (const line of createInterface(childProcess.stdout as NodeJS.ReadableStream)) {
          logger.debug('[worker-console] ' + line);
        }
      })().catch((err) => {
        logger.error(err);
      });
    }
    if (childProcess.stderr) {
      (async () => {
        for await (const line of createInterface(childProcess.stderr as NodeJS.ReadableStream)) {
          logger.error('[worker-console] ' + line);
        }
      })().catch((err) => {
        logger.error(err);
      });
    }
    childProcess.on('close', (code, signal) => {
      logger.info(`${logTag}child process closed with code ${code} and signal ${signal}`);
    });
    childProcess.on('exit', (code, signal) => {
      logger.info(`${logTag}child process exited with code ${code} and signal ${signal}`);
    });
    childProcess.on('error', (err) => {
      logger.error(`${logTag}child process error: ${err}`);
    });
    const logStream = childProcess.stdio[workerLogFd];
    if (logStream) {
      (async () => {
        for await (const line of createInterface(logStream as NodeJS.ReadableStream)) {
          const j = JSON.parse(line);
          const { level, message } = j;
          logger[level as keyof typeof logger]('[Worker] ' + message);
        }
      })().catch((err) => {
        logger.error(`${logTag}OMS builder log read failed: %o`, err);
      });
    }
    const ipc = new Ipc<ClientInvocationMethodId, ServerInvocationMethodId>({
      send: (message) => {
        childProcess.send(message);
      },
    });
    const listen_vendor = ipc.listen;
    ipc.listen = function (...args) {
      const [methodId, callback, ...remainArgs] = args;
      logger.debug(`${logTag}Listening to ${methodId}`);
      return listen_vendor.call(this, methodId, async (...args) => {
        // logger.debug(`${logTag}Received ${methodId} with args: %o`, args);
        await callback(...args);
      }, ...remainArgs);
    };
    childProcess.on('message', (message) => {
      ipc.dispatch(message as InvocationMessage);
    });

    const {
      promise: bootstrapPromise,
      resolve: resolveBootstrap,
      reject: rejectBootstrap,
    } = promiseWithResolvers<void>();
    ipc.listen('bootstrapped', async () => {
      try {
        logger.debug(`${logTag}OMS builder has bootstrapped`);
        logger.info(`${logTag}Worker bootstrapped in ${Date.now() - spawnStart}ms`);
        const setupIpcStart = Date.now();
        await ipc.invoke('setup', {
          project: Editor.Project.path,
        });
        logger.info(`${logTag}Worker setup IPC done in ${Date.now() - setupIpcStart}ms`);
        resolveBootstrap();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        rejectBootstrap(new Error(`${logTag}OMS builder setup IPC failed using ${runtime.description}: ${message}`));
        childProcess.kill();
      }
    });

    ipc.listen('pong', async () => {
      this._pongReceived = true;
    });

    ipc.listen('passive-build-end', async (result) => {
      await this._handleBuildResult(result.result, 'passive build');
    });

    ipc.listen('build-start', async (opts) => {
      this._handleBuildStart();
      broadcastInner(InnerPackageMessageId.buildStart, {
        ...opts,
      });
    });

    ipc.listen('build-end', async (opts) => {
      broadcastInner(InnerPackageMessageId.buildEnd, {
        ...opts,
      });
    });

    try {
      await Promise.race([bootstrapPromise, processAbortedPromise]);
    } finally {
      childProcess.off('error', onProcessError);
      childProcess.off('exit', onProcessExit);
    }

    logger.info(`${logTag}Builder setup done in ${Date.now() - setupStart}ms`);
    logger.debug(`${logTag}Builder has setup`);

    return {
      ipc,
      childProcess,
    };
  }

  private async _selectBuilderRuntime(): Promise<BuilderRuntime> {
    const runElectronAsNode: boolean = await Editor.Profile.getProject(
      selfPackageName,
      'builder.useElectronRunAsNode',
    );
    if (!runElectronAsNode) {
      const embeddedRuntimeIssue = 'Electron RunAsNode is disabled by project setting';
      logger.info(`${logTag}${embeddedRuntimeIssue}; checking external Node from PATH`);
      return await this._selectExternalNode(embeddedRuntimeIssue);
    }

    const electronVersion = process.versions.electron;
    const embeddedNodeVersion = process.versions.node;
    if (electronVersion && satisfiesSemver(embeddedNodeVersion, supportedNodeVersionRange)) {
      try {
        await this._probeElectronRunAsNode(electronVersion, embeddedNodeVersion);
        return {
          executable: process.execPath,
          description: `Electron ${electronVersion} RunAsNode (Node ${embeddedNodeVersion})`,
          runElectronAsNode: true,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const embeddedRuntimeIssue = `Electron ${electronVersion} embeds supported Node ${embeddedNodeVersion}, but its RunAsNode probe failed (${message})`;
        logger.warn(`${logTag}${embeddedRuntimeIssue}; trying external Node from PATH`);
        return await this._selectExternalNode(embeddedRuntimeIssue);
      }
    }

    const embeddedRuntimeIssue = electronVersion
      ? `Electron ${electronVersion} embeds Node ${embeddedNodeVersion}, which does not satisfy ${supportedNodeVersionRange}`
      : `the current process is not Electron (Node ${embeddedNodeVersion}), so Electron RunAsNode is unavailable`;
    return await this._selectExternalNode(embeddedRuntimeIssue);
  }

  private _probeElectronRunAsNode(electronVersion: string, embeddedNodeVersion: string): Promise<void> {
    const probePath = resolve(selfPackagePath, 'dist/worker/run-as-node-probe.cjs');
    const expectedOutput = `oms-run-as-node-probe:${electronVersion}:${embeddedNodeVersion}`;
    return new Promise((resolveProbe, rejectProbe) => {
      cp.execFile(process.execPath, [probePath, sandboxieRunAsNodeProcessTypeArg], {
        encoding: 'utf8',
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
        },
        timeout: runAsNodeProbeTimeoutMs,
      }, (error, stdout) => {
        if (error) {
          if (error.killed) {
            rejectProbe(new Error(`timed out after ${runAsNodeProbeTimeoutMs}ms`));
          } else {
            rejectProbe(new Error(error.message));
          }
          return;
        }
        const output = stdout.trim();
        if (output !== expectedOutput) {
          rejectProbe(new Error(`expected ${JSON.stringify(expectedOutput)}, received ${JSON.stringify(output)}`));
          return;
        }
        resolveProbe();
      });
    });
  }

  private async _selectExternalNode(embeddedRuntimeIssue: string): Promise<BuilderRuntime> {
    let externalNodeVersion: string;
    try {
      externalNodeVersion = await this._probeExternalNodeVersion();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `${logTag}Cannot start OMS builder: ${embeddedRuntimeIssue}; external Node from PATH is unavailable (${message}); required Node version is ${supportedNodeVersionRange}`,
      );
    }
    if (!satisfiesSemver(externalNodeVersion, supportedNodeVersionRange)) {
      throw new Error(
        `${logTag}Cannot start OMS builder: ${embeddedRuntimeIssue}; external Node ${externalNodeVersion} from PATH does not satisfy ${supportedNodeVersionRange}`,
      );
    }
    return {
      executable: 'node',
      description: `external Node ${externalNodeVersion} from PATH`,
      runElectronAsNode: false,
    };
  }

  private _probeExternalNodeVersion(): Promise<string> {
    return new Promise((resolve, reject) => {
      cp.execFile('node', ['-v'], {
        encoding: 'utf8',
      }, (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        const versionText = stdout.trim();
        const version = cleanSemver(versionText);
        if (!version) {
          reject(new Error(`node -v returned an invalid version ${JSON.stringify(versionText)}`));
          return;
        }
        resolve(version);
      });
    });
  }

  private _filterPackage(pkg: Editor.Interface.PackageInfo) {
    if (pkg.invalid) {
      return false;
    }
    if (!pkg.enable) {
      return false;
    }
    if (!pkg.path.startsWith(Editor.Project.path)) {
      return false;
    }
    return true;
  }

  private async _updateBuildOptions() {
    this._invalidateBuildResult();
    const buildOptions = await this._makeBuildOptions();
    const serverAgent = await this._setupPromise;
    if (!serverAgent) {
      return;
    }
    await serverAgent.ipc.invoke('update-build-options', buildOptions);
  }

  private async _makeBuildOptions(): Promise<BuildOptions> {
    const pkgs = Editor.Package.getPackages({
      enable: true,
      invalid: false,
    });
    const extensionBuildOptions: ExtensionBuildOptions[] = [];
    for (const pkg of pkgs) {
      if (pkg.path.startsWith(Editor.Project.path)) {
        extensionBuildOptions.push({
          name: pkg.name,
          path: pkg.path,
        });
      }
    }
    return {
      extensionBuildOptions,
    };
  }

  private async _handleBuildResult(
    buildResult: ProtocolBuildResult,
    reason: string,
    opts: HandleBuildResultOptions = {},
  ) {
    this._rememberBuildResult(buildResult);
    if (buildResult.ok) {
      const reloadAssetDbRuntime = opts.reloadAssetDbRuntime ?? true;
      // 不要在这里 await，因为场景进程可能正在等待 db，而 db 又在等待我们，造成死循环。
      Editor.Message.request('scene', 'execute-scene-script', {
        name: selfPackageName,
        method: 'reloadScripts' satisfies keyof SceneMethods,
        args: [reason] as Parameters<SceneMethods['reloadScripts']>,
      }).catch((err) => {
        logger.error(`execute-scene-script failed: ${err}`);
      });
      if (reloadAssetDbRuntime) {
        Editor.Message.request('asset-db', 'execute-script', {
          name: selfPackageName,
          method: 'reloadRuntime',
          args: [reason],
        }).catch((err) => {
          logger.error(`reload asset-db OMS runtime failed: ${err}`);
        });
      }

      for (const file of buildResult.affectedFiles) {
        logger.debug(`${logTag}Reimport asset: %s`, file);
        await Editor.Message.request('asset-db', 'refresh-asset', file);
      }
    } else {
      logger.error(`${buildResult.error.message}`);
    }
  }

  private _handleBuildStart() {
    this._invalidateBuildResult();
  }

  private _rememberBuildResult(buildResult: ProtocolBuildResult) {
    this._lastBuildResult = buildResult;
  }

  private _invalidateBuildResult() {
    this._lastBuildResult = undefined;
  }

  private _toWorkerBuildResult(buildResult: ProtocolBuildResult): BuildResult {
    if (!buildResult.ok) {
      return buildResult;
    }
    return {
      ok: true,
      beginningModules: buildResult.affectedFiles,
    };
  }
}

interface ServerAgent {
  ipc: Ipc<ClientInvocationMethodId, ServerInvocationMethodId>;
  childProcess: cp.ChildProcess;
}

interface BuilderRuntime {
  executable: string;
  description: string;
  runElectronAsNode: boolean;
}

interface HandleBuildResultOptions {
  reloadAssetDbRuntime?: boolean;
}

enum StateType {
  opening,
  opened,
  closing,
  closed,
}
