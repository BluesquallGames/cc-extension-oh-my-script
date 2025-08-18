import { logger } from './logger.js';
import { objectAssignDeep } from './utils/object-assign-deep.js';
import type { Contributions } from './utils/contributions.js';
import { workerMessageDescriptions } from './worker/worker-message-descriptions.js';

export async function register(info: {
  contributions: Contributions;
}) {
  const contributions = await getContributions();
  objectAssignDeep(info.contributions ??= {}, contributions);
  logger.debug(`registered contributions: ${JSON.stringify(contributions, undefined, 2)}`);
}

type Methods = keyof typeof import('./main.js')['methods'];

async function getContributions(): Promise<Contributions> {
  const workerMessagesContribution = Object.fromEntries(
    Object.keys(workerMessageDescriptions).map((messageName) => [messageName, { methods: [messageName] }]),
  ) as {
    [x in keyof typeof workerMessageDescriptions]: {
      methods: x[];
    }
  };

  const menuPath = 'Oh My Script!';

  return {
    'asset-db': {
      mount: {
        path: './mount/assets',
      },
    },
    'builder': './dist/contributions/builder/index.cjs',
    'messages': {
      'open-devtools': {
        methods: ['open-devtools'],
      },
      ...workerMessagesContribution,
    } satisfies {
      [x in Methods]: {
        methods: x[];
      }
    },
    'menu': [
      {
        path: menuPath,
        label: 'Open OMS Devtools',
        message: 'open-devtools',
        group: 'operation',
        order: 9,
      },

      {
        path: menuPath,
        label: 'Rebuild',
        message: 'rebuild' satisfies keyof typeof workerMessagesContribution,
        group: 'operation',
        order: 10,
      },

      {
        path: menuPath,
        label: 'Restart',
        message: 'restart' satisfies keyof typeof workerMessagesContribution,
        group: 'operation',
        order: 11,
      },

      {
        path: menuPath,
        label: 'Inline UUIDs',
        message: 'inline-uuids' satisfies keyof typeof workerMessagesContribution,
        group: 'operation',
        order: 12,
      },
    ],
    'server': './dist/contributions/server.cjs',
  };
}
