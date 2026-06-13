import { logger } from '../../logger.js';
import type { BuildResult } from '../../worker/worker-message-descriptions.js';
import { ReloadInterruptError, SceneModuleSystem } from './module-system.js';

type OmsGlobalImport = (moduleId: string) => Promise<unknown>;

export interface OmsScriptRuntimeOptions {
  label: string;
  ensureBuild?: () => Promise<BuildResult | undefined>;
}

export class OmsScriptRuntimeError extends Error {
  constructor(message: string, options: { label: string; cause: unknown }) {
    const causeMessage = OmsScriptRuntimeError._formatCause(options.cause);
    super(`${message} in ${options.label}${causeMessage ? `: ${causeMessage}` : ''}`);
    this.name = 'OmsScriptRuntimeError';
    this.cause = options.cause;
  }

  cause?: unknown;

  private static _formatCause(cause: unknown) {
    if (!cause) {
      return '';
    }
    if (cause instanceof ReloadInterruptError) {
      return cause.message;
    }
    if (cause instanceof Error) {
      return cause.message;
    }
    if (typeof cause === 'object' && 'message' in cause && typeof cause.message === 'string') {
      return cause.message;
    }
    if (typeof cause === 'string') {
      return cause;
    }
    try {
      return JSON.stringify(cause);
    } catch {
      return `${cause}`;
    }
  }
}

export class OmsScriptRuntime {
  constructor(options: OmsScriptRuntimeOptions) {
    this._label = options.label;
    this._ensureBuild = options.ensureBuild;
    this._moduleSystem = new SceneModuleSystem();
  }

  installGlobalImport() {
    Object.defineProperty(globalThis, '__oms_import__', {
      value: this._globalImport,
      writable: true,
      enumerable: false,
      configurable: true,
    });
  }

  async import(moduleId: string) {
    await this.ensureReady('__oms_import__');
    return await this._moduleSystem.import(moduleId);
  }

  async ensureReady(reason = 'ensureReady') {
    if (this._ready) {
      return;
    }
    if (this._reloadPromise) {
      await this._awaitReload();
      return;
    }

    const buildResult = this._ensureBuild ? await this._ensureBuild() : undefined;
    if (buildResult && !buildResult.ok) {
      this._lastError = buildResult.error;
      throw new OmsScriptRuntimeError('OMS build failed', {
        label: this._label,
        cause: buildResult.error,
      });
    }

    this.reload(reason);
    await this._awaitReload();
  }

  reload(reason?: string) {
    const logReason = reason ? ` (${reason})` : '';
    logger.debug(`[${this._label}] Reloading OMS runtime${logReason}`);
    this._ready = false;
    const reloadPromise = this._moduleSystem.reload().then(() => {
      this._ready = true;
      this._lastError = undefined;
      logger.debug(`[${this._label}] OMS runtime reloaded`);
    }).catch((err: unknown) => {
      this._ready = false;
      this._lastError = err;
      if (err instanceof ReloadInterruptError) {
        throw err;
      }
      throw new OmsScriptRuntimeError('OMS runtime reload failed', {
        label: this._label,
        cause: err,
      });
    }).finally(() => {
      if (this._reloadPromise === reloadPromise) {
        this._reloadPromise = undefined;
      }
    });
    this._reloadPromise = reloadPromise;
    return reloadPromise;
  }

  private async _awaitReload() {
    for (;;) {
      const reloadPromise = this._reloadPromise;
      if (!reloadPromise) {
        return;
      }
      try {
        await reloadPromise;
        return;
      } catch (err) {
        if (err instanceof ReloadInterruptError && this._reloadPromise && this._reloadPromise !== reloadPromise) {
          continue;
        }
        throw err;
      }
    }
  }

  private _label: string;
  private _ensureBuild: (() => Promise<BuildResult | undefined>) | undefined;
  private _moduleSystem: SceneModuleSystem;
  private _ready = false;
  private _lastError: unknown;
  private _reloadPromise: Promise<void> | undefined;
  private _globalImport: OmsGlobalImport = async (moduleId) => await this.import(moduleId);
}

declare global {
  // eslint-disable-next-line no-var
  var __oms_import__: OmsGlobalImport | undefined;
}
