import assert from 'node:assert';
import { OmsBuilder } from './oms-builder.js';
import { ServerContext } from './server-context.js';
import { logger } from './logger.js';

export interface MessageHandlerRegistry {
  close(): Promise<void>;
}

export function registerMessageHandlers(ctx: ServerContext) {
  let globalOmsBuilder: OmsBuilder | undefined = undefined;

  ctx.ipc.listen('setup', async (args) => {
    assert(!globalOmsBuilder, 'omsBuilder already setup');
    globalOmsBuilder = new OmsBuilder(ctx, args);
    globalOmsBuilder.on('passive-build-end', (buildResult) => {
      void ctx.ipc.invoke('passive-build-end', buildResult).catch((err) => {
        logger.error('Failed to deliver passive build result: %o', err);
      });
    });
    globalOmsBuilder.on('passive-profile-build-end', (buildResult) => {
      void ctx.ipc.invoke('passive-profile-build-end', buildResult).catch((err) => {
        logger.error(`Failed to deliver passive ${buildResult.profile} profile build result: %o`, err);
      });
    });
  });

  ctx.ipc.listen('rebuild', async (opts) => {
    const omsBuilder = ensureOmsBuilder();
    return await omsBuilder.rebuild(opts);
  });

  ctx.ipc.listen('clean-rebuild', async (opts) => {
    const omsBuilder = ensureOmsBuilder();
    return await omsBuilder.cleanRebuild(opts);
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
    void ctx.ipc.invoke('pong', undefined).catch((err) => {
      logger.error('Failed to deliver pong: %o', err);
    });
  });

  return {
    async close() {
      const omsBuilder = globalOmsBuilder;
      globalOmsBuilder = undefined;
      await omsBuilder?.close({ waitForTasks: false });
    },
  } satisfies MessageHandlerRegistry;

  function ensureOmsBuilder() {
    assert(globalOmsBuilder, 'omsBuilder not setup');
    return globalOmsBuilder;
  }
}
