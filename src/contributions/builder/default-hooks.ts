import { BuildHook } from '@cocos/creator-types/editor/packages/builder/@types/protected.js';
import { logger } from '../../logger.js';
import { resolve } from 'node:path';
import { requestSelfWorkerMessage } from '../../utils/request-self.js';

const logTag = `[builder.default-hooks]`;

export const load: BuildHook.load = async () => {
  logger.debug(`${logTag} load.`);
};

export const unload: BuildHook.unload = async () => {
  logger.debug(`${logTag} unload.`);
};

export const onBeforeBuild: BuildHook.onBeforeBuild = async (options, result) => {
  logger.debug(`${logTag} on-before-build. Options: %o\n.Result: %o`, options, result);
  if (options.preview) {
    logger.debug(`The build request is emitted for previewing, ignored.`);
    return;
  }
};

export const onAfterBuild: BuildHook.onAfterBuild = async (options, result) => {
  logger.debug(`${logTag} on-after-build.`);
  if (options.preview) {
    logger.debug(`The build request is emitted for previewing, ignored.`);
    return;
  }
  await requestSelfWorkerMessage('build-prod', {
    buildDir: resolve(result.paths.dir),
    debug: options.debug,
    sourceMaps: options.sourceMaps,
    platform: options.platform,
  });
};
