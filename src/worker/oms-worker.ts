import EventEmitter from 'node:events';
import { resolve } from 'node:path';
import { logger } from '../logger.js';

export class OmsWorker {
  constructor(private _nodeWorker: CreatorWorker) {
    _nodeWorker.win.webContents.on('did-finish-load', () => {
      _nodeWorker.require(resolve(__dirname, 'worker/worker-entry-prelude.cjs'));
      _nodeWorker.require(resolve(__dirname, 'worker/worker-entry.cjs'));
    });
  }

  openDevtools() {
    this._nodeWorker.debug(true);
  }

  async request(method: string, ...args: unknown[]) {
    logger.debug(`Request to worker "${method}", with arguments: [${args.join(', ')}]`);
    const result = await this._nodeWorker.send(method, ...args);
    console.debug(`Response from worker "${method}": ${result}`);
    return result;
  }
}

interface CreatorWorker {
  win: {
    webContents: EventEmitter;
  };

  debug(flag: boolean): void;

  require(module: string): void;

  send(method: string, ...args: unknown[]): Promise<unknown>;
}
