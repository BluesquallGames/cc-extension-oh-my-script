import assert from 'node:assert';
import { OmsBuilder } from './oms-builder.js';
import { ServerContext } from './server-context.js';

export function registerMessageHandlers(ctx: ServerContext) {
  let globalOmsBuilder: OmsBuilder | undefined = undefined;

  ctx.ipc.listen('setup', async (args) => {
    assert(!globalOmsBuilder, 'omsBuilder already setup');
    globalOmsBuilder = new OmsBuilder(ctx, args);
  });

  ctx.ipc.listen('rebuild', async () => {
    const omsBuilder = ensureOmsBuilder();
    await omsBuilder.rebuild();
  });

  ctx.ipc.listen('inline-uuids', async () => {
    await (ensureOmsBuilder()).inlineUUIDs();
  });

  ctx.ipc.listen('build-prod', async (opts) => {
    await (ensureOmsBuilder()).buildProd(opts);
  });

  ctx.ipc.listen('update-build-options', async (options) => {
    await (ensureOmsBuilder()).updateBuildOptions(options);
  });

  function ensureOmsBuilder() {
    assert(globalOmsBuilder, 'omsBuilder not setup');
    return globalOmsBuilder;
  }
}
