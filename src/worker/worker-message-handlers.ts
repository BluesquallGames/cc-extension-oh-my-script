import { OmsBuilderAgent } from './oms-builder-agent.js';
import { workerMessageDescriptions } from './worker-message-descriptions.js';

const omsBuilderAgent = new OmsBuilderAgent();

export const workerMessageHandlers = {
  rebuild: async () => {
    await omsBuilderAgent.rebuild();
  },
} satisfies Record<keyof typeof workerMessageDescriptions, () => Promise<void>>;
