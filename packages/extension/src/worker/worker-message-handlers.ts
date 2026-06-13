import { OmsBuilderAgent } from './oms-builder-agent.js';
import { workerMessageDescriptions, type WorkerMessageSignature } from './worker-message-descriptions.js';

const omsBuilderAgent = new OmsBuilderAgent();
omsBuilderAgent.addListener('setup', () => {
  // noop
});

export const workerMessageHandlers = {
  'rebuild': async (opts) => {
    return await omsBuilderAgent.rebuild(opts);
  },

  'ensure-runtime-build': async () => {
    return await omsBuilderAgent.ensureRuntimeBuild();
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
