import EventEmitter from 'node:events';
import { resolve } from 'node:path';
import { logger } from '../logger.js';
import { workerMessageDescriptions } from './worker-message-descriptions.js';

export class OmsWorker {
  constructor(private _nodeWorker: CreatorWorker) {
    _nodeWorker.win.webContents.on('did-finish-load', () => {
      _nodeWorker.require(resolve(__dirname, 'worker/worker-entry-prelude.cjs'));
      _nodeWorker.require(resolve(__dirname, 'worker/worker-entry.cjs'));
      this._ready = true;
      const readyPromiseWithResolvers = this._readyPromiseWithResolvers;
      this._readyPromiseWithResolvers = undefined;
      if (readyPromiseWithResolvers) {
        readyPromiseWithResolvers.resolve();
      }
    });
  }

  async ready() {
    if (this._ready) {
      return;
    }
    this._readyPromiseWithResolvers ??= promiseWithResolvers();
    return this._readyPromiseWithResolvers.promise;
  }

  openDevtools() {
    this._nodeWorker.debug(true);
  }

  async request<TMethod extends keyof typeof workerMessageDescriptions>(method: TMethod,
    ...args: unknown[]) {
    logger.debug(`Request to worker "${method}", with arguments: [${args.join(', ')}]`);
    const result = await this._nodeWorker.send(method, ...args);
    console.debug('Response from worker "%s": %o', method, result);
    return result;
  }

  private _readyPromiseWithResolvers: PromiseWithResolvers<void> | undefined;
  private _ready = false;
}

interface CreatorWorker {
  win: {
    webContents: EventEmitter;
  };

  debug(flag: boolean): void;

  require(module: string): void;

  send(method: string, ...args: unknown[]): Promise<unknown>;
}

interface PromiseWithResolvers<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function promiseWithResolvers<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolve_, reject_) => {
    resolve = resolve_;
    reject = reject_;
  });
  return {
    promise,
    resolve,
    reject,
  };
}
