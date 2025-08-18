import { OmsBuilderAgent } from './oms-builder-agent.js';
import { workerMessageDescriptions, WorkerMessageSignature } from './worker-message-descriptions.js';

const omsBuilderAgent = new OmsBuilderAgent();

export const workerMessageHandlers = {
  'rebuild': async () => {
    await omsBuilderAgent.rebuild();
  },

  'restart': async () => {
    await omsBuilderAgent.restart();
  },

  'inline-uuids': async () => {
    await omsBuilderAgent.inlineUUIDs();
  },

  'build-prod': async (opts) => {
    await omsBuilderAgent.buildProd(opts);
  },
} satisfies {
  [k in keyof typeof workerMessageDescriptions]: WorkerMessageSignature<k>;
};
