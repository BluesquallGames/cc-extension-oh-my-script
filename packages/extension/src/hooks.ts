/// <reference types="@feb/cc-extension-utils/types/contribution-modules" />

import { logger } from './logger.js';
import { workerMessageDescriptions } from './worker/worker-message-descriptions.js';
import { ExtensionContributions, mergeContributions } from '@feb/cc-extension-utils/extension';
import sceneContributionScript from './contributions/scene/index.ts?contribution-script';
import serverContributionScript from './contributions/server.ts?contribution-script';
import footerContributionScript from './contributions/footer/right.ts?contribution-script';
import builderContributionScript from './contributions/builder/index.ts?contribution-script';
import assetDbContributionScript from './contributions/asset-db/index.ts?contribution-script';
import { relative } from 'node:path';
import { selfPackagePath } from './self-info.js';

export async function register(info: {
  contributions: ExtensionContributions;
}) {
  const contributions = await getContributions();
  mergeContributions(info.contributions ??= {}, contributions);
  logger.debug(`registered contributions: ${JSON.stringify(contributions, undefined, 2)}`);
}

type Methods = keyof typeof import('./main.js')['methods'];

async function getContributions(): Promise<ExtensionContributions> {
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
      'script': transformContributionScriptPath(assetDbContributionScript),

      'mount': {
        path: './mount/assets',
      },

      'global-hook': [
        'beforePreStart',
        'afterPreStart',
      ],
    },

    'builder': transformContributionScriptPath(builderContributionScript),

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

    'scene': {
      script: transformContributionScriptPath(sceneContributionScript),
    },

    'server': transformContributionScriptPath(serverContributionScript),

    'footer': {
      right: transformContributionScriptPath(footerContributionScript),
    },
  };
}

function transformContributionScriptPath(path: string) {
  return relative(selfPackagePath, path);
}
