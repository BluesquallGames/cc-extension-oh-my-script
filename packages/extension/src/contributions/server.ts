import { join } from 'node:path';
import { logger } from '../logger';

export const get: unknown[] = [
  {
    url: `/${'oms'}/*`,
    handle(request: {
      params: [subpath: string];
    }, response: {
      status: number;
      end: () => void;
      sendFile: (path: string) => void;
    }) {
      const subpath = request.params[0];
      logger.debug(`Request for oms file: ${subpath}`);
      const baseDir = join(Editor.Project.tmpDir, 'oms', 'out');
      const file = join(baseDir, subpath);
      response.sendFile(file);
    },
  },
];
