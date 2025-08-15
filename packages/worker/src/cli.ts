import { logger } from './logger.js';
import { OmsBuilder } from './oms-builder.js';
import { Ipc } from './protocol.js';

const builder = new OmsBuilder({
  ipc: new Ipc({
    send(message) {
      logger.debug(`Send IPC message: %o`, message);
    },
  }),
}, {
  project: process.argv[process.argv.length - 1],
});

await builder.rebuild();
