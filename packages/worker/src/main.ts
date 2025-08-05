import process from 'node:process';
import { InvocationResult, InvocationMessage, InvocationMethodId } from './protocol.js';
import { messageHandlers } from './message-handlers.js';
import { logger } from './logger.js';

logger.debug('oms worker is executing');

function sendInvocationResult<T extends InvocationMethodId>(sendHandle: unknown, result: InvocationResult<T>) {
  process.send?.(result, sendHandle);
}

process.on('message', async (message: InvocationMessage, sendHandle) => {
  const handler = messageHandlers[message.method];
  if (!handler) {
    return void sendInvocationResult(sendHandle, {
      invocationId: message.invocationId,
      ok: false,
      error: new Error(`No handler for message type ${message.method}`),
    });
  }
  try {
    // @ts-expect-error
    const returnValue = await handler(message.args);
    return void sendInvocationResult(sendHandle, {
      invocationId: message.invocationId,
      ok: true,
      returnValue,
    });
  } catch (error) {
    return void sendInvocationResult(sendHandle, {
      invocationId: message.invocationId,
      ok: false,
      error: error instanceof Error ? error.toString() : String(error),
    });
  }
});

export {};
