import cp from 'node:child_process';
import { logger } from '../logger.js';
import { InvocationResult, InvocationReturnValue, InvocationMessage, InvocationParams, InvocationMethodId } from '@oms/worker/protocol';

export class OmsBuilderAgent {
  constructor() {

  }

  async rebuild() {
    const channel = await this._setup();
    await channel.invoke('rebuild', undefined);
  }

  private _setupPromise: Promise<Channel> | undefined = undefined;

  private async _setup() {
    if (!this._setupPromise) {
      this._setupPromise = this._doSetup();
    }
    return this._setupPromise;
  }

  private async _doSetup(): Promise<Channel> {
    const main = require.resolve('@oms/worker/main');
    const childProcess = cp.spawn('node', ['--inspect', main], {
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
    const invocations: Map<number, (response: InvocationResult<InvocationMethodId>) => void> = new Map();
    childProcess.on('message', (invocationResult: InvocationResult<InvocationMethodId>) => {
      logger.debug(`Received message: ${JSON.stringify(invocationResult)}`);
      const invocation = invocations.get(invocationResult.invocationId);
      if (!invocation) {
        logger.error(`No invocation found for message: ${JSON.stringify(invocationResult)}`);
      } else {
        invocation(invocationResult);
      }
    });
    let nextInvocationId = 1;
    const channel = {
      invoke: <T extends InvocationMethodId>(type: T, content: InvocationParams<T>) => {
        const invocationId = nextInvocationId++;
        const message: InvocationMessage<T> = {
          invocationId,
          method: type,
          args: content,
        };
        logger.debug(`Sending message: ${JSON.stringify(message)}`);
        childProcess.send(message);
        return new Promise<InvocationReturnValue<T>>((resolve, reject) => {
          invocations.set(invocationId, (response: InvocationResult<InvocationMethodId>) => {
            invocations.delete(invocationId);
            if (response.ok) {
              resolve(response.returnValue as InvocationReturnValue<T>);
            } else {
              reject(new Error(response.error));
            }
          });
        });
      },
    };
    await channel.invoke('setup', {
      project: Editor.Project.path,
    });
    return channel;
  }
}

interface Channel {
  invoke<T extends InvocationMethodId>(type: T, content: InvocationParams<T>): Promise<InvocationReturnValue<T>>;
}
