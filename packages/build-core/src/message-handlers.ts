import assert from 'node:assert';
import { OmsBuilder } from './oms-builder.js';
import { ServerContext } from './server-context.js';

export function registerMessageHandlers(ctx: ServerContext) {
  let globalOmsBuilder: OmsBuilder | undefined = undefined;

  ctx.ipc.listen('setup', async (args) => {
    assert(!globalOmsBuilder, 'omsBuilder already setup');
    globalOmsBuilder = new OmsBuilder(ctx, args);
    globalOmsBuilder.on('passive-build-end', (buildResult) => {
      ctx.ipc.invoke('passive-build-end', buildResult);
    });
  });

  ctx.ipc.listen('rebuild', async (opts) => {
    const omsBuilder = ensureOmsBuilder();
    return await omsBuilder.rebuild(opts);
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

  ctx.ipc.listen('ping', async () => {
    ctx.ipc.invoke('pong', undefined);
  });

  function ensureOmsBuilder() {
    assert(globalOmsBuilder, 'omsBuilder not setup');
    return globalOmsBuilder;
  }
}
