import { setTimeout } from 'node:timers/promises';
import { logger } from '../../logger.js';
import { selfExtensionName } from '../../self-info.js';
import { requestSelfWorkerMessage } from '../../utils/request-self.js';
import { type BuildResult } from '../../worker/worker-message-descriptions.js';
import { ReloadInterruptError } from '../scene/module-system.js';
import { OmsScriptRuntime } from '../scene/oms-script-runtime.js';

interface AssetDBInfo {
  preImportExtList?: string[];
}

enum AssetDBRuntimePhase {
  starting = 'starting',
  startupReloading = 'startupReloading',
  ready = 'ready',
}

const firstBuildSyncTaskName = `${selfExtensionName}:first-build`;
const firstBuildSyncTaskMessage = `Building ${selfExtensionName} project scripts...`;
const firstBuildSyncTaskDetail = 'Waiting for first build';

export async function load() {
  firstBuildResult = undefined;
  runtimePhase = AssetDBRuntimePhase.starting;
  pendingReadyReloadReason = undefined;
  globalScriptRuntime.ensure();
}

const globalScriptRuntime = (() => {
  let scriptRuntime: OmsScriptRuntime | undefined;
  return {
    ensure() {
      if (scriptRuntime) {
        return scriptRuntime;
      }
      scriptRuntime = new OmsScriptRuntime({
        label: 'asset-db',
        ensureBuild: async () => await requestSelfWorkerMessage('ensure-runtime-build'),
      });
      scriptRuntime.installGlobalImport();
      return scriptRuntime;
    },

    get() {
      return scriptRuntime;
    },
  };
})();

let firstBuildResult: BuildResult | undefined = undefined;
let runtimePhase = AssetDBRuntimePhase.starting;
let pendingReadyReloadReason: string | undefined = undefined;

export const methods = {
  async beforePreStart(assetDBInfo: AssetDBInfo) {
    void assetDBInfo;
    logger.debug(`Wait for ${selfExtensionName} first build...`);
    const timeoutSec = 1 * 60;
    Editor.Task.__protected__.addSyncTask(firstBuildSyncTaskName, firstBuildSyncTaskMessage);
    Editor.Task.__protected__.updateSyncTask(
      firstBuildSyncTaskName,
      firstBuildSyncTaskMessage,
      firstBuildSyncTaskDetail,
    );
    try {
      firstBuildResult = await Promise.race([
        requestSelfWorkerMessage('rebuild', {
          reason: 'asset-db startup build',
          reloadAssetDbRuntime: false,
        }),
        setTimeout(timeoutSec * 1000).then(() => {
          throw new Error(`${selfExtensionName} first build timeout after ${timeoutSec}s`);
        }),
      ]);
      logger.debug(`${selfExtensionName} first build done: %o`, firstBuildResult);
    } catch (err) {
      logger.error(`${selfExtensionName} first build failed: %o`, err);
    } finally {
      Editor.Task.__protected__.removeSyncTask(firstBuildSyncTaskName);
    }
  },

  async afterPreStart(assetDBInfo: AssetDBInfo) {
    void assetDBInfo;
    runtimePhase = AssetDBRuntimePhase.startupReloading;
    try {
      if (firstBuildResult?.ok) {
        logger.debug(`Run project scripts in asset-db`);
        await globalScriptRuntime.ensure().ensureReady('asset-db afterPreStart');
      }
    } catch (err) {
      if (err instanceof ReloadInterruptError) {
        logger.debug('Asset-db OMS runtime reload interrupted.');
      } else {
        logger.error(`Failed to run project scripts in asset-db: %o`, err);
      }
    } finally {
      runtimePhase = AssetDBRuntimePhase.ready;
    }

    const pendingReason = pendingReadyReloadReason;
    pendingReadyReloadReason = undefined;
    if (pendingReason) {
      try {
        await globalScriptRuntime.get()?.reload(pendingReason);
      } catch (err) {
        if (err instanceof ReloadInterruptError) {
          logger.debug('Asset-db OMS runtime reload interrupted.');
        } else {
          logger.error(`Failed to reload OMS runtime in asset-db: %o`, err);
        }
      }
    }
  },

  async reloadRuntime(reason?: string) {
    switch (runtimePhase) {
    case AssetDBRuntimePhase.starting:
      logger.debug(`Skip asset-db OMS runtime reload before startup reload. Reason: ${reason}`);
      return;
    case AssetDBRuntimePhase.startupReloading:
      pendingReadyReloadReason = reason ?? 'build success';
      logger.debug(`Defer asset-db OMS runtime reload until startup reload finishes. Reason: ${reason}`);
      return;
    case AssetDBRuntimePhase.ready:
      break;
    }
    try {
      await globalScriptRuntime.get()?.reload(reason ?? 'build success');
    } catch (err) {
      if (err instanceof ReloadInterruptError) {
        logger.debug('Asset-db OMS runtime reload interrupted.');
        return;
      }
      logger.error(`Failed to reload OMS runtime in asset-db: %o`, err);
    }
  },
};
