import { BuildPlugin } from '@cocos/creator-types/editor/packages/builder/@types/protected.js';
import { logger } from '../../logger.js';

export const load: BuildPlugin.load = async () => {
  logger.debug(`Builder load.`);
};

export const unload: BuildPlugin.Unload = async () => {
  logger.debug(`Builder unload.`);
};

export const configs: BuildPlugin.Configs = {
  '*': {
    hooks: './default-hooks.cjs',
  },
};
