import { logger } from '../../logger.js';
import { ReloadInterruptError } from './module-system.js';
import { OmsScriptRuntime } from './oms-script-runtime.js';
import { requestSelfWorkerMessage } from '../../utils/request-self.js';

export async function load() {
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
        label: 'scene',
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
    globalScriptRuntime.get()?.reload(reason).then(() => {
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
