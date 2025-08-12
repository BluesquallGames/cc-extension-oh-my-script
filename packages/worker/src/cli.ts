import { OmsBuilder} from './oms-builder.js';
import { Ipc } from './protocol.js';

const builder = new OmsBuilder({
  ipc: new Ipc({
    send(message) {
      
    },
  }),
}, {
  project: process.argv[process.argv.length - 1],
});

await builder.rebuild();
