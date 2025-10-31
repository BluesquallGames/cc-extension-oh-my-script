import cp from 'node:child_process';
import { logger } from '../logger.js';
import { Ipc, InvocationMessage, ClientInvocationMethodId, ServerInvocationMethodId, setLogger, BuildOptions, ExtensionBuildOptions } from '@oms/build-core/protocol';
import { addEditorBroadcastListener } from '../utils/editor/common.js';
import { addListenerOnPackageEnabled, addListenerOnPackageDisabled } from '../utils/editor/extension.js';

setLogger(logger);

const logTag = '[BuilderAgent] ';

export class OmsBuilderAgent {
  constructor() {
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
    switch (this._state) {
    case State.closing:
    case State.closed:
      return;
    }

    this._state = State.closing;
    if (this._setupPromise) {
      const setupPromise = this._setupPromise;
      this._setupPromise = undefined;
      try {
        const serverAgent = await setupPromise;
        serverAgent.childProcess.kill();
      } catch (err) {
        logger.error(`${logTag}close builder agent failed: ${err}`);
      } finally {
        this._state = State.closed;
      }
    }
  }

  async rebuild() {
    switch (this._state) {
    case State.closing:
      logger.error(`${logTag} is not opened`);
      return;
    }

    const serverAgent = await this._setup();
    await this._updateBuildOptions();
    await serverAgent.ipc.invoke('rebuild', undefined);
  }

  async restart() {
    await this.close();
    await this.rebuild();
  }

  async inlineUUIDs() {
    switch (this._state) {
    case State.closing:
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
  }) {
    switch (this._state) {
    case State.closing:
      logger.error(`${logTag} is not opened`);
      return;
    }

    const serverAgent = await this._setup();
    await serverAgent.ipc.invoke('build-prod', opts);
  }

  private _state = State.closed;
  private _setupPromise: Promise<ServerAgent> | undefined = undefined;

  private async _setup() {
    if (!this._setupPromise) {
      this._state = State.opening;
      this._setupPromise = this._doSetup().then((serverAgent) => {
        this._state = State.opened;
        return serverAgent;
      }).catch((err) => {
        this._state = State.closed;
        throw err;
      });
    }
    return this._setupPromise;
  }

  private async _doSetup(): Promise<ServerAgent> {
    const main = require.resolve('@oms/build-core/main');
    const childProcess = cp.spawn('node', ['--inspect', main], {
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    });
    childProcess.stdout?.on('data', (data) => {
      logger.info('[worker] ' + data.toString());
    });
    childProcess.stderr?.on('data', (data) => {
      logger.error('[worker] ' + data.toString());
    });
    childProcess.on('close', (code, signal) => {
      logger.info(`${logTag}child process closed with code ${code} and signal ${signal}`);
    });
    childProcess.on('exit', (code, signal) => {
      logger.info(`${logTag}child process exited with code ${code} and signal ${signal}`);
    });
    childProcess.on('error', (err) => {
      logger.error(`${logTag}child process error: ${err}`);
    });
    await new Promise<cp.ChildProcess>((resolve, reject) => {
      childProcess.on('spawn', () => {
        resolve(childProcess);
      });
      childProcess.on('error', (err) => {
        reject(err);
      });
    });

    const ipc = new Ipc<ClientInvocationMethodId, ServerInvocationMethodId>({
      send: (message) => {
        childProcess.send(message);
      },
    });
    childProcess.on('message', (message) => {
      ipc.dispatch(message as InvocationMessage);
    });
    const listen_vendor = ipc.listen;
    ipc.listen = function (...args) {
      const [methodId, callback, ...remainArgs] = args;
      logger.debug(`${logTag}Listening to ${methodId}`);
      return listen_vendor.call(this, methodId, async (...args) => {
        logger.debug(`${logTag}Received ${methodId} with args: %o`, args);
        await callback(...args);
      }, ...remainArgs);
    };

    ipc.listen('build-failed', async (err) => {
      let m = err.message;
      if (err.stack) {
        m += `\n${err.stack}`;
      }
      logger.error(m);
    });

    ipc.listen('build-success', async (changes) => {
      for (const file of changes.affectedFiles) {
        logger.debug(`${logTag}Reimport asset: %s`, file);
        await Editor.Message.request('asset-db', 'reimport-asset', file);
      }
    });

    await new Promise<void>((resolve, reject) => {
      ipc.listen('bootstrapped', async () => {
        await ipc.invoke('setup', {
          project: Editor.Project.path,
        });
        resolve();
      });
    });

    logger.debug(`${logTag}Builder has setup`);

    return {
      ipc,
      childProcess,
    };
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
}

interface ServerAgent {
  ipc: Ipc<ClientInvocationMethodId, ServerInvocationMethodId>;
  childProcess: cp.ChildProcess;
}

enum State {
  opening,
  opened,
  closing,
  closed,
}
