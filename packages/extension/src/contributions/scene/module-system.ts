import { ModuleRequestMeta, Registration, RegistryManagement, SystemJS } from '@oms/systemjs';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';
import fs from 'node:fs/promises';
import { logger } from '../../logger.js';
import { join } from 'node:path';
import { cclegacy, js } from 'cc';
import { TaskQueue } from '@oms/task-queue';
import console from 'node:console';
import { HotConsole } from './hot-console.js';

const omsURLPrefix = 'oms://';

interface ReloadState {
  seqId: number;
  interruptController: AbortController;
  pending: boolean;
}

export class ReloadInterruptError extends Error {
  constructor(...args: ConstructorParameters<typeof Error>) {
    super(...args);
  }
}

type ReloadTaskMap = {
  reload: () => Promise<void>;
};

export class SceneModuleSystem {
  constructor() {
    this._systemJS = new SystemJS();
    const vendorCreateContext = this._systemJS.createContext.bind(this._systemJS);
    this._systemJS.createContext = this._createContext.bind(this, vendorCreateContext);
    this._systemJS.resolve = this._resolve.bind(this);
    this._systemJS.instantiate = this._instantiate.bind(this);
    this._systemJS.onload = this._onModuleLoad.bind(this);
    this._registryManagement = new RegistryManagement(this._systemJS);
    this._externalSystemJSModules = [
      'cc',
      'cc/env',
    ];
    this._omsModuleDir = pathToFileURL(join(Editor.Project.path, 'temp/oms/out/')).href;
  }

  reload(): Promise<void> {
    if (this._runningReloadState.pending) {
      logger.debug(`${this._runningReloadingLogTag}Aborting since new reload request...`);
      this._runningReloadState.interruptController.abort();
    }
    return this._reloadTaskQueue.queueTask({
      type: 'reload',
      exec: async (ctx) => {
        this._runningReloadState.interruptController = new AbortController();
        this._runningReloadState.seqId = this._nextReloadSeqId++;
        this._runningReloadState.pending = true;
        logger.debug(`${this._runningReloadingLogTag}Started.`);
        try {
          await this._doReload();
        } finally {
          this._runningReloadState.pending = false;
        }
        logger.debug(`${this._runningReloadingLogTag}Finished.`);
      },
    });
  }

  private _systemJS: SystemJS;
  private _registryManagement: RegistryManagement;
  private _externalSystemJSModules: string[] = [];
  private _instantiatedHotModules: Set<string> = new Set();
  private _omsModuleDir: string;
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  private _registeredClasses = new Set<Function>();
  private _reloadTaskQueue = new TaskQueue<ReloadTaskMap>();
  private _nextReloadSeqId = 1;
  private _runningReloadState: ReloadState = {
    seqId: 0,
    interruptController: new AbortController(),
    pending: false,
  };

  private _controllerOnDispose = new AbortController();

  private _hotConsole = new HotConsole();

  private get _runningReloadingLogTag() {
    return `[reloading-${this._runningReloadState.seqId}] `;
  }

  private _checkReloadState() {
    if (this._runningReloadState.interruptController.signal.aborted) {
      logger.debug(`${this._runningReloadingLogTag}Aborted.`);
      throw new ReloadInterruptError(`${this._runningReloadingLogTag}Aborted`);
    }
  }

  private async _doReload() {
    this._controllerOnDispose.abort();
    this._controllerOnDispose = new AbortController();

    this._hotConsole.clear();

    this._unregisterClasses();
    this._invalidateHotModules();

    const disposeClassRegistrationContext = this._setupClassRegistrationContext();
    try {
      await this._reloadOmsModules();
    } finally {
      disposeClassRegistrationContext();
    }
  }

  private _createContext(vendorCreateContext: typeof this._systemJS.createContext, id: string) {
    const vendor = vendorCreateContext(id);
    const signalOnDispose = this._controllerOnDispose.signal;
    return {
      ...vendor,
      hot: {
        signalOnDispose,
      },
    };
  }

  private _resolve(id: string, parent?: string, meta?: ModuleRequestMeta): string {
    if (this._externalSystemJSModules.includes(id)) {
      return id;
    }

    let url: URL;
    try {
      url = new URL(id, parent);
    } catch (err) {
      throw new Error(`${this._runningReloadingLogTag}Failed to resolve module ${id}(${parent ? `from ${parent})` : ''}):  ${err}`);
    }

    if (url.href.startsWith(omsURLPrefix)) {
      return new URL(url.href.slice(omsURLPrefix.length), this._omsModuleDir).href;
    }

    return url.href;
  }

  private async _instantiate(id: string, parent?: string, meta?: ModuleRequestMeta): Promise<Registration> {
    if (this._externalSystemJSModules.includes(id)) {
      return this._instantiateExternalSystemJSModule(id, parent, meta);
    }

    if (id.startsWith('file:')) {
      // 必须要在 instantiate 之前记录，否则 instantiate 出错的情况下后面就无法移除了
      this._instantiatedHotModules.add(id);
      const register = await this._instantiateSystemJSModuleFile(id);
      return register;
    }

    throw new Error(`${this._runningReloadingLogTag}Unable to instantiate module ${id}`);
  }

  private async _instantiateExternalSystemJSModule(id: string, parent?: string, meta?: ModuleRequestMeta): Promise<Registration> {
    const m = await (globalThis as unknown as {
      System: SystemJS;
    }).System.import(id, parent, meta);
    this._checkReloadState();
    return [
      [],
      (_export) => {
        return {
          execute: () => {
            _export(m);
          },
        };
      },
    ] as const;
  }

  private async _instantiateSystemJSModuleFile(path: string) {
    await this._evaluateSystemJSModuleFile(path);
    const register = this._systemJS.getRegister();
    if (!register) {
      throw new Error(`${this._runningReloadingLogTag}${path} does not provide a SystemJS register.`);
    }
    return register;
  }

  private async _evaluateSystemJSModuleFile(url: string) {
    const path = fileURLToPath(url);
    logger.debug(`${this._runningReloadingLogTag}Evaluate ${path}`);
    let code = '';
    try {
      code = await fs.readFile(path, 'utf8');
    } catch (err) {
      throw new Error(`${this._runningReloadingLogTag}Failed to read module ${path}: ${err}`);
    }
    this._checkReloadState();
    this._evaluateWrap(code, url);
  }

  private _evaluateWrap(code: string, url: string) {
    const intrinsics: Record<string, unknown> = {
      System: this._systemJS,
      console: this._hotConsole,
    };
    let fn: (...args: unknown[]) => void;
    try {
      fn = new Function(...Object.keys(intrinsics), code + `\n//# sourceURL=${url}`) as typeof fn;
    } catch (err) {
      throw new Error(`${this._runningReloadingLogTag}Failed to read module ${url}: ${err}`);
    }
    try {
      fn(...Object.values(intrinsics));
    } catch (err) {
      throw new Error(`${this._runningReloadingLogTag}Failed to execute module ${url}: ${err}`);
    }
  }

  private _onModuleLoad(err: unknown, id: string, deps: string[] | undefined, isErrSource: boolean) {
  }

  private _setupClassRegistrationContext() {
    const onClassRegistered = this._onClassRegistered.bind(this);
    // @ts-expect-error
    EditorExtends.on('class-registered', onClassRegistered);
    return () => {
      // @ts-expect-error
      EditorExtends.removeListener('class-registered', onClassRegistered);
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  private _onClassRegistered(cls: Function) {
    this._registeredClasses.add(cls);
    logger.debug(`${this._runningReloadingLogTag}Register ${cls.name}`);
  }

  private _unregisterClasses() {
    for (const registeredClass of this._registeredClasses) {
      js.unregisterClass(registeredClass);
    }
    logger.debug(`${this._runningReloadingLogTag}Unregister ${[...this._registeredClasses].map((c) => c.name).join(', ')}`);
    this._registeredClasses.clear();
    cclegacy._RF.reset();
  }

  private _invalidateHotModules() {
    for (const id of this._instantiatedHotModules) {
      const result = this._registryManagement.delete(id);
      if (!result) {
        logger.warn(`${this._runningReloadingLogTag}Failed to invalidate module ${id}, maybe it's being executing?`);
      }
    }
    this._instantiatedHotModules.clear();
  }

  private async _reloadOmsModules() {
    const { default: metadata } = (await this._systemJS.import(`${omsURLPrefix}metadata.js`, undefined)) as {
      default: {
        entries: Array<[bundleId: string, isEditorEntry: boolean]>;
      };
    };
    for (const [bundleId] of metadata.entries) {
      const restoreRequiringFrames = saveRequiringFrames();
      try {
        await this._systemJS.import(`${omsURLPrefix}bundle-${bundleId}.js`);
      } finally {
        restoreRequiringFrames();
      }
    }
  }
}

function saveRequiringFrames() {
  const frames: {
    module: unknown;
    uuid: string;
    script: unknown;
    importMeta: unknown;
  }[] = [];
  const RF = cclegacy._RF;
  for (; ;) {
    const frame = RF.peek();
    if (!frame) {
      break;
    }
    frames.push(frame);
    RF.pop();
  }
  return () => {
    const nFrames = frames.length;
    for (let i = nFrames - 1; i >= 0; --i) {
      const frame = frames[i];
      RF.push(
        frame.module,
        frame.uuid,
        frame.script,
        frame.importMeta,
      );
    }
    frames.length = 0;
  };
}
