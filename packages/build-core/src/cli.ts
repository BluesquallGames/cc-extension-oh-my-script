import { logger } from './logger.js';
import { OmsBuilder } from './oms-builder.js';
import { Ipc, type ServerInvocationMethodId, type ClientInvocationMethodId, InvocationDirection } from './protocol.js';

const ipc = new Ipc<ServerInvocationMethodId, ClientInvocationMethodId>({
  send(message) {
    logger.debug(`Send IPC message: %o`, message);
    if (message.direction === InvocationDirection.call) {
      Promise.resolve().then(() => {
        ipc.dispatch({
          direction: InvocationDirection.returns,
          invocationId: message.invocationId,
          ok: true,
          returnValue: undefined,
        });
      }).catch((err) => {
        logger.error(err);
      });
    }
  },
});
const builder = new OmsBuilder({
  ipc,
}, {
  project: process.argv[process.argv.length - 1],
});

void builder;
