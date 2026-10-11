import process from 'node:process';
import {
  Ipc,
  type InvocationMessage,
  type ClientInvocationMethodId,
  type ServerInvocationMethodId,
} from './protocol.js';
import { registerMessageHandlers } from './message-handlers.js';
import { logger } from './logger.js';
import { ServerContext } from './server-context.js';
import { installProcessDisconnectShutdown } from './process-lifetime.js';

function main() {
  logger.debug('oms worker is executing');

  const ipc = new Ipc<ServerInvocationMethodId, ClientInvocationMethodId>({
    send: (message) => {
      if (!process.connected || !process.send) {
        return;
      }
      try {
        process.send(message);
      } catch (err) {
        if (isDisconnectedIpcError(err)) {
          return;
        }
        throw err;
      }
    },
  });
  process.on('message', (message) => {
    ipc.dispatch(message as InvocationMessage);
  });

  const ctx = new ServerContext(ipc);

  const messageHandlerRegistry = registerMessageHandlers(ctx);
  process.on('error', (err) => {
    if (isDisconnectedIpcError(err)) {
      return;
    }
    throw err;
  });
  installProcessDisconnectShutdown({
    cleanup: async () => {
      await messageHandlerRegistry.close();
    },
  });

  ctx.ipc.invoke('bootstrapped', undefined).catch((err) => {
    logger.error('oms worker bootstrap failed: %o', err);
  });
}

function isDisconnectedIpcError(err: unknown) {
  if (!(err instanceof Error)) {
    return false;
  }
  const code = (err as NodeJS.ErrnoException).code;
  return code === 'EPIPE' || code === 'ERR_IPC_CHANNEL_CLOSED';
}

try {
  main();
} catch (err) {
  logger.error('oms worker failed', err);
}

export {};
