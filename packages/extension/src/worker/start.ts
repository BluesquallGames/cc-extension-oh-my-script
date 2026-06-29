import { requireEditorModule2 } from '@cyclonium/cc-extension-utils/require-editor-module';
import { OmsWorker } from './oms-worker.js';
import assert from 'node:assert';
import { logger } from '../logger.js';
import { workerMessageDescriptions } from './worker-message-descriptions.js';

let globalOmsWorker: OmsWorker | undefined;

export async function startWorker() {
  assert(globalOmsWorker === undefined, 'OMSWorker already started');

  const Worker = requireEditorModule2('@base/electron-worker');
  const worker = Worker.create('oms-worker');

  const creator = requireEditorModule2('@editor/creator');
  const requireFile = creator.getPreloadFilePath();
  logger.debug(`OMSWorker preload file: ${requireFile}`);
  await worker.init({
    preload: requireFile,
  });
  globalOmsWorker = new OmsWorker(worker);
  await globalOmsWorker.ready();
  if (process.argv.includes('--open-oms-devtools')) {
    globalOmsWorker.openDevtools();
  }
}

export async function openOmsDevtools() {
  assert(globalOmsWorker !== undefined, 'OMSWorker not started');
  globalOmsWorker.openDevtools();
}

export const workerMethods = Object.fromEntries(Object.keys(workerMessageDescriptions).map ((workerMessageName) => {
  return [
    workerMessageName,
    async (...args: unknown[]) => {
      const omsWorker = ensureOmsWorker();
      return await omsWorker.request(workerMessageName as keyof typeof workerMessageDescriptions, ...args);
    },
  ];
})) as {
  [x in keyof typeof workerMessageDescriptions]: (...args: unknown[]) => Promise<unknown>;
};

function ensureOmsWorker() {
  if (globalOmsWorker === undefined) {
    throw new Error('OMSWorker not started');
  }
  return globalOmsWorker;
}
