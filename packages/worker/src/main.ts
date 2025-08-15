import process from 'node:process';
import { Ipc, type InvocationMessage, type ClientInvocationMethodId, type ServerInvocationMethodId } from './protocol.js';
import { registerMessageHandlers } from './message-handlers.js';
import { logger } from './logger.js';
import { ServerContext } from './server-context.js';

async function main() {
  logger.debug('oms worker is executing');

  const ipc = new Ipc<ServerInvocationMethodId, ClientInvocationMethodId>({
    send: (message) => {
      process.send?.(message);
    },
  });
  process.on('message', (message) => {
    ipc.dispatch(message as InvocationMessage);
  });

  const ctx = new ServerContext(ipc);

  registerMessageHandlers(ctx);

  ctx.ipc.invoke('bootstrapped', undefined).catch((err) => {
    logger.error('oms worker bootstrap failed: %o', err);
  });
}

main().catch((err) => {
  logger.error('oms worker failed', err);
});

export {};
