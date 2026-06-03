import { logger } from '../../logger.js';
import { ReloadInterruptError } from './module-system.js';
import { SceneScriptManager } from './scene-script-manager.js';

let sceneScriptManager: SceneScriptManager | undefined;

export async function load() {
  sceneScriptManager = new SceneScriptManager({
    globalImport: true,
  });
}

declare global {
  namespace cce {
    export const Script: {
      EXECUTION_FINISHED: 'EXECUTION_FINISHED';
      emit: (event: string) => void;
    };
  }
}

let iReload = 0;

export const methods = {
  async reloadScripts(reason?: string) {
    logger.debug(`Reloading scene scripts...${iReload++}. Reason: ${reason}`);
    sceneScriptManager?.reload().then(() => {
      logger.debug('Scene scripts reloaded successfully.');
      cce.Script.emit(cce.Script.EXECUTION_FINISHED);
    }).catch((err) => {
      if (err instanceof ReloadInterruptError) {
        logger.debug('Reload interrupted.');
        return;
      }
      logger.error(`Failed to reload scene scripts: ${err}`);
    });
  },
};

export type SceneMethods = typeof methods;
