import { setTimeout } from 'node:timers/promises';
import { logger } from '../../logger.js';
import { selfExtensionName } from '../../self-info.js';
import { requestSelfWorkerMessage } from '../../utils/request-self.js';
import { type BuildResult } from '../../worker/worker-message-descriptions.js';
import { SceneScriptManager } from '../scene/scene-script-manager.js';

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
    const timeoutSec = 1 * 60;
    try {
      firstBuildResult = await Promise.race([
        requestSelfWorkerMessage('rebuild'),
        setTimeout(timeoutSec * 1000).then(() => {
          throw new Error(`${selfExtensionName} first build timeout after ${timeoutSec}s`);
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
      if (!firstBuildResult.ok) {
        return;
      }
      try {
        logger.debug(`Run project scripts in asset-db`);
        const scriptManager = new SceneScriptManager();
        await scriptManager.reload();
      } catch (err) {
        logger.error(`Failed to run project scripts in asset-db: %o`, err);
      }
    }
  },
};
