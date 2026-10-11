/// <reference types="@cocos/creator-types/engine.d.ts"/>
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="../../../../temp/declarations/cc.env.d.ts"/>

declare interface SystemJS {
  register: (dependencies: unknown, declare: unknown) => void;
  resolve: (id: string, parent?: string) => string;
  instantiate: (id: string, parentURL: string | undefined) => void;
  delete: (id: string) => void;
}

declare const System: SystemJS;

import { HTML5, PREVIEW, EDITOR, NATIVE, EDITOR_NOT_IN_PREVIEW } from 'cc/env';
import { cclegacy } from 'cc';

let omsBaseDir = '';
const omsURLPrefix = 'oms:///';
const logTag = '[OMS] ';

if (EDITOR) {
  const r = require;
  const ps = r('path');
  const {
    URL,
    pathToFileURL,
    fileURLToPath,
  } = r('url');
  const fs = r('fs');
  // @ts-expect-error The editor injects Editor outside the mounted asset's type environment.
  omsBaseDir = ps.join(Editor.Project.tmpDir, 'oms/out', ps.sep);
  const omsBaseURL = pathToFileURL(omsBaseDir);

  interface OmsSystemInfo {
    vendorResolve: (specifier: string, parent?: string) => Promise<void>;
    vendorInstantiate: () => void;
    vendorCreateContext: (id: string, ...args: unknown[]) => Record<string, unknown>;
    instantiatedModules: string[];
    hot: {
      controllerOnDispose: AbortController;
    };
  }
  const omsSymbol = Symbol.for('oms');

  const systemJSPrototype = System.constructor.prototype;
  const oldSystemInfo = systemJSPrototype[omsSymbol] as OmsSystemInfo | undefined;
  if (oldSystemInfo) {
    oldSystemInfo.hot.controllerOnDispose.abort('OMS module dispose');
    for (const instantiatedModule of oldSystemInfo.instantiatedModules) {
      System.delete(instantiatedModule);
    }
    oldSystemInfo.instantiatedModules.length = 0;
  }

  const vendorResolve = oldSystemInfo?.vendorResolve ?? systemJSPrototype.resolve;
  const vendorInstantiate = oldSystemInfo?.vendorInstantiate ?? systemJSPrototype.instantiate;
  const vendorCreateContext = oldSystemInfo?.vendorCreateContext ?? systemJSPrototype.createContext;
  const omsSystemInfo = systemJSPrototype[omsSymbol] = {
    instantiatedModules: [],
    vendorInstantiate,
    vendorResolve,
    vendorCreateContext,
    hot: {
      controllerOnDispose: new AbortController(),
    },
  } as OmsSystemInfo;

  systemJSPrototype.resolve = function (id: string, ...args: unknown[]) {
    if (id.startsWith(omsURLPrefix)) {
      const subpath = id.slice(omsURLPrefix.length);
      return new URL('./' + subpath, omsBaseURL).href;
    }
    return vendorResolve.call(this, id, ...args);
  };

  systemJSPrototype.instantiate = async function (id: string, parentURL: string
    | undefined, ...args: unknown[]) {
    if (id.startsWith(omsBaseURL)) {
      console.debug(`${logTag}Instantiate ${id}`);
      omsSystemInfo.instantiatedModules.push(id);
      const path = fileURLToPath(id);
      let register: unknown[] | undefined;
      try {
        await retryByInterval(() => {
          const register_vendor = systemJSPrototype.register;
          systemJSPrototype.register = function (dependencies: unknown, declare: unknown) {
            if (register) {
              throw new Error(`${path} unexpectedly provided multiple System registers.`);
            }
            register = [dependencies, declare];
          };
          const exec = (path: string) => {
            let code: string;
            try {
              code = fs.readFileSync(path, 'utf8');
            } catch (err) {
              throw new Error(`Failed to read module ${path}: ${String(err)}`, { cause: err });
            }
            let fn: (system: SystemJS) => void;
            try {
              // System.register bundles execute against the editor's module registry.
              // eslint-disable-next-line @typescript-eslint/no-implied-eval
              fn = new Function('System', code + `\n//# sourceURL=${pathToFileURL(path)
                .href}`) as typeof fn;
            } catch (err) {
              throw new Error(`Failed to read module ${path}: ${String(err)}`, { cause: err });
            }
            try {
              fn(System);
            } catch (err) {
              throw new Error(`Failed to execute module ${path}: ${String(err)}`, { cause: err });
            }
          };
          try {
            exec(path);
          } finally {
            systemJSPrototype.register = register_vendor;
            delete r.cache[path];
          }
        }, 100, 1000, `Instantiate ${id}`);
      } catch (err) {
        console.error(`${logTag}Failed to instantiate ${id}: %o`, err);
        throw err;
      }
      if (!register) {
        throw new Error(`${path} does not provide a SystemJS register.`);
      }
      return register;
    }
    return vendorInstantiate.call(this, id, parentURL, ...args);
  };

  systemJSPrototype.createContext = function (id: string, ...args: unknown[]) {
    const vendorContext = vendorCreateContext.call(this, id, ...args);
    vendorContext.hot = {
      signalOnDispose: omsSystemInfo.hot.controllerOnDispose.signal,
    };
    return vendorContext;
  };

  async function retryByInterval<T>(execute: () => Promise<T> | T, interval: number,
    timeout: number, title: string) {
    const t0 = Date.now();
    for (let iTry = 0; ; ++iTry) {
      try {
        const result = await execute();
        if (iTry > 0) {
          console.info(
            `${logTag}Note: ${title} eventually succeeded after ${iTry} tries. This is not an error.`);
        }
        return result;
      } catch (err) {
        const t1 = Date.now();
        const dt = t1 - t0;
        if (dt >= timeout) {
          throw err;
        }
        console.debug(`${logTag}[${iTry + 1}]-th retry ${title} failed, retry after ${interval}ms`);
      }
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
  }
} else {
  const systemJSPrototype = System.constructor.prototype;

  let omsHostBaseURLPrefix = '';
  if (HTML5) {
    omsHostBaseURLPrefix = new globalThis.URL('./oms/', document.baseURI).href;
  } else if (NATIVE) {
    omsHostBaseURLPrefix = `no-schema:/oms/`;
  } else {
    omsHostBaseURLPrefix = `project:/oms/`;
  }

  const vendorResolve = systemJSPrototype.resolve;
  systemJSPrototype.resolve = function (id: string, ...args: unknown[]) {
    if (id.startsWith(omsURLPrefix)) {
      const subpath = id.slice(omsURLPrefix.length);
      return `${omsHostBaseURLPrefix}${subpath}`;
    }
    return vendorResolve.call(this, id, ...args);
  };

  // const vendorInstantiate = systemJSPrototype.instantiate;
  // systemJSPrototype.instantiate = function (id: string, parentURL: string | undefined, ...args:
  // unknown[]) {
  //   if (id.startsWith(omsHostBaseURLPrefix)) {
  //   }
  // };
}

function prepareInEditor(id: string, parent: string) {
  const r = require;
  const path = r('path').join(omsBaseDir, id);
  const specifier = r('url').pathToFileURL(path).href;
  const resolved = import.meta.resolve(specifier, parent);
  return resolved;
}

function prepareInWeb(id: string, parent: string) {
  void parent;
  return `/oms/${id}`;
}

export async function load(id: string, parent: string) {
  let specifier = id;
  if (EDITOR) {
    specifier = prepareInEditor(id, parent);
  } else if (HTML5 && PREVIEW) {
    specifier = prepareInWeb(id, parent);
  }
  await import(specifier);
}

export async function loadBundleEntry(bundleId: string, _parent: string) {
  try {
    return await import(`${omsURLPrefix}${makeOmsEntryFileName(`bundle-${bundleId}`)}.js`);
  } catch (err) {
    console.error(`Failed to load bundle entry: ${bundleId}, did you installed OMS extension?`);
    throw err;
  }
}

export async function loadOMSExports(id: string, parent: string) {
  void parent;
  const entryFileName = makeOmsEntryFileName(id);
  if (entryFileName === id) {
    throw new Error(`Invalid OMS exports id: ${id}`);
  }
  try {
    return await import(`${omsURLPrefix}${entryFileName}.js`);
  } catch (err) {
    console.error(`Failed to load OMS exports: ${id}, did you installed OMS extension?`);
    throw err;
  }
}

function makeOmsEntryFileName(entryId: string) {
  const importSpecifierFileName = makeOmsImportSpecifierFileName(entryId);
  if (importSpecifierFileName) {
    return importSpecifierFileName;
  }
  if (entryId.includes('://')) {
    return entryId;
  }
  const iColon = entryId.indexOf(':');
  if (iColon < 0) {
    return entryId;
  }
  const domainId = entryId.slice(0, iColon);
  const exportId = entryId.slice(iColon + 1);
  if (!domainId || !exportId) {
    return entryId;
  }
  return `exports/${domainId}/${exportId === '.' ? 'index' : exportId}`;
}

function makeOmsImportSpecifierFileName(moduleId: string) {
  const match = /^oms:\/\/([^/]+)(?:\/(.*))?$/.exec(moduleId);
  if (!match) {
    return undefined;
  }
  const exportId = normalizeExportId(match[2] || '.');
  return `exports/${match[1]}/${exportId === '.' ? 'index' : exportId}`;
}

function normalizeExportId(exportId: string) {
  if (exportId === '' || exportId === '.') {
    return '.';
  }
  return exportId.replace(/^\.\//, '').replace(/^\/+/, '');
}

export function saveRequiringFrames() {
  const frames: Array<{
    module: unknown;
    uuid: string;
    script: unknown;
    importMeta: unknown;
  }> = [];
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

export async function start() {
  const { default: metadata } = (await import(`${omsURLPrefix}metadata.js`)) as {
    default: {
      entries: Array<[bundleId: string, isEditorEntry: boolean]>;
      exports?: Record<string, string>;
    };
  };
  for (const [bundleId, isEditorEntry] of metadata.entries) {
    if (!EDITOR_NOT_IN_PREVIEW && isEditorEntry) {
      continue;
    }
    const restoreRequiringFrames = saveRequiringFrames();
    try {
      await loadBundleEntry(bundleId, '');
    } finally {
      restoreRequiringFrames();
    }
  }
}
