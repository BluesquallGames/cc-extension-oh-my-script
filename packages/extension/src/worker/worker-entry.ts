import { logger } from '../logger.js';
import { CreatorWorker } from './worker-ipc.js';
import { workerMessageDescriptions } from './worker-message-descriptions.js';
import { workerMessageHandlers } from './worker-message-handlers.js';

logger.debug(`Executing worker entry`);

for (const [methodMessageName, _] of Object.entries(workerMessageDescriptions)) {
  if (!(methodMessageName in workerMessageHandlers)) {
    console.error(`Worker does not accept a message called ${methodMessageName}`);
    continue;
  }

  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  const method = (workerMessageHandlers as Record<string, Function>)[methodMessageName];
  CreatorWorker.Ipc.on(methodMessageName, (event, ...args: unknown[]) => {
    logger.debug(`Worker accept: ${methodMessageName}(${args.join(', ')})`);
    Promise.resolve<unknown>(method(...args)).then((result: unknown) => {
      event.reply(null, result);
    }).catch((err) => {
      event.reply(err);
    });
  });
}
