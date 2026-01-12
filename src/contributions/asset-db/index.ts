import { setTimeout } from 'node:timers/promises';
import { logger } from '../../logger.js';
import { selfExtensionName } from '../../self-info.js';
import { requestSelfWorkerMessage } from '../../utils/request-self.js';
import { type BuildResult } from '../../worker/worker-message-descriptions.js';

interface AssetDBInfo {
  preImportExtList?: string[];
}

export async function load() {

}

let firstBuildResult: BuildResult | undefined = undefined;

export const methods = {
  async beforePreStart(assetDBInfo: AssetDBInfo) {
    void assetDBInfo;
    logger.debug(`Wait for ${selfExtensionName} first build...`);
    try {
      firstBuildResult = await Promise.race([
        requestSelfWorkerMessage('rebuild'),
        setTimeout(1000 * 15).then(() => {
          throw new Error(`${selfExtensionName} first build timeout after 15s`);
        }),
      ]);
      logger.debug(`${selfExtensionName} first build done: %o`, firstBuildResult);
    } catch (err) {
      logger.error(`${selfExtensionName} first build failed: %o`, err);
    }
  },

  async afterPreStart(assetDBInfo: AssetDBInfo) {
    void assetDBInfo;
    if (firstBuildResult) {
      for (const beggingModulePath of firstBuildResult.beginningModules) {
        try {
          const dbURL = await Editor.Message.request('asset-db', 'query-url', beggingModulePath);
          if (!dbURL) {
            throw new Error(`Failed to query url for asset: ${beggingModulePath}, 'query-url' method returned empty nil`);
          }
          await Editor.Module.importProjectModule(dbURL);
        } catch (err) {
          logger.error(`Failed to import asset: ${beggingModulePath}, error: %o`, err);
        }
      }
    }
  },
};
