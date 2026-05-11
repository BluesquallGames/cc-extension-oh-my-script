import './initialize-logger.js';
import { logger } from './logger.js';
import { selfExtensionName } from './self-info.js';
import { openOmsDevtools, startWorker, workerMethods } from './worker/start.js';

export const methods = {
  'open-devtools': async () => {
    await openOmsDevtools();
  },

  ...workerMethods,
} as const;

export async function load() {
  logger.debug(`${selfExtensionName} loaded`);
  await startWorker();
}

export function unload() {
  logger.debug(`${selfExtensionName} unloaded`);
}
