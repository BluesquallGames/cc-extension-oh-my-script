import assert from 'node:assert';
import { OmsBuilder } from './oms-builder.js';
import { InvocationParams, InvocationReturnValue, InvocationMethodId } from './protocol.js';

let globalOmsBuilder: OmsBuilder | undefined = undefined;

export const messageHandlers: {
  [key in InvocationMethodId]?: (message: InvocationParams<key>) => InvocationReturnValue<key>;
} = {
  setup: async (options) => {
    assert(!globalOmsBuilder, 'omsBuilder already setup');
    globalOmsBuilder = new OmsBuilder(options);
  },

  rebuild: async () => {
    const omsBuilder = ensureOmsBuilder();
    await omsBuilder.rebuild();
  },
};

function ensureOmsBuilder() {
  assert(globalOmsBuilder, 'omsBuilder not setup');
  return globalOmsBuilder;
}
