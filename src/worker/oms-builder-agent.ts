import cp from 'node:child_process';
import { logger } from '../logger.js';
import { Ipc, InvocationMessage, ClientInvocationMethodId, ServerInvocationMethodId } from '@oms/worker/protocol';

export class OmsBuilderAgent {
  constructor() {

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
        logger.error(`close builder agent failed: ${err}`);
      } finally {
        this._state = State.closed;
      }
    }
  }

  async rebuild() {
    switch (this._state) {
    case State.closing:
      logger.info('builder agent is not opened');
      return;
    }

    const serverAgent = await this._setup();
    await serverAgent.ipc.invoke('rebuild', undefined);
  }

  async restart() {
    await this.close();
    await this.rebuild();
  }

  async inlineUUIDs() {
    switch (this._state) {
    case State.closing:
      logger.info('builder agent is not opened');
      return;
    }

    const serverAgent = await this._setup();
    await serverAgent.ipc.invoke('inline-uuids', undefined);
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
    const main = require.resolve('@oms/worker/main');
    const childProcess = cp.spawn('node', ['--watch', '--inspect', main], {
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    });
    childProcess.stdout?.on('data', (data) => {
      logger.info(data);
    });
    childProcess.stderr?.on('data', (data) => {
      logger.error(data);
    });
    childProcess.on('close', (code, signal) => {
      logger.info(`child process closed with code ${code} and signal ${signal}`);
    });
    childProcess.on('exit', (code, signal) => {
      logger.info(`child process exited with code ${code} and signal ${signal}`);
    });
    childProcess.on('error', (err) => {
      logger.error(`child process error: ${err}`);
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

    ipc.listen('build-failed', async (err) => {
      let m = err.message;
      if (err.stack) {
        m += `\n${err.stack}`;
      }
      logger.error(m);
    });

    ipc.listen('build-success', async (changes) => {
      for (const file of changes.affectedFiles) {
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

    return {
      ipc,
      childProcess,
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
