// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="../../../../temp/declarations/cc.d.ts"/>
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="../../../../temp/declarations/cc.env.d.ts"/>

declare interface SystemJS {
  register: (dependencies: unknown, declare: unknown) => void;
  resolve: (id: string, parent?: string) => string;
  instantiate: (id: string, parentURL: string | undefined) => void;
  delete: (id: string) => void;
}

declare const System: SystemJS;

import { HTML5, PREVIEW, EDITOR, BUILD, NATIVE } from 'cc/env';
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
  omsBaseDir = ps.join(Editor.Project.tmpDir, 'oms/out', ps.sep);
  const omsBaseURL = pathToFileURL(omsBaseDir);

  interface OmsSystemInfo {
    vendorResolve: (specifier: string, parent?: string) => Promise<void>;
    vendorInstantiate: () => void;
    instantiatedModules: string[];
  }
  const omsSymbol = Symbol.for('oms');

  const systemJSPrototype = System.constructor.prototype;
  const oldSystemInfo = systemJSPrototype[omsSymbol] as OmsSystemInfo | undefined;
  if (oldSystemInfo) {
    for (const instantiatedModule of oldSystemInfo.instantiatedModules) {
      System.delete(instantiatedModule);
    }
    oldSystemInfo.instantiatedModules.length = 0;
  }

  const vendorResolve = oldSystemInfo?.vendorResolve ?? systemJSPrototype.resolve;
  const vendorInstantiate = oldSystemInfo?.vendorInstantiate ?? systemJSPrototype.instantiate;
  const omsSystemInfo = systemJSPrototype[omsSymbol] = {
    instantiatedModules: [],
    vendorInstantiate,
    vendorResolve,
  } as OmsSystemInfo;

  systemJSPrototype.resolve = function (id: string, ...args: unknown[]) {
    if (id.startsWith(omsURLPrefix)) {
      const subpath = id.slice(omsURLPrefix.length);
      return new URL('./' + subpath, omsBaseURL).href;
    }
    return vendorResolve.call(this, id, ...args);
  };

  systemJSPrototype.instantiate = async function (id: string, parentURL: string | undefined, ...args: unknown[]) {
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
          try {
            r(path);
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

  async function retryByInterval<T>(execute: () => Promise<T> | T, interval: number, timeout: number, title: string) {
    const t0 = Date.now();
    for (let iTry = 0; ; ++iTry) {
      try {
        const result = await execute();
        if (iTry > 0) {
          console.info(`${logTag}Note: ${title} eventually succeeded after ${iTry} tries. This is not an error.`);
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
    omsHostBaseURLPrefix = new globalThis.URL('./oms/', window.location.href).href;
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
  // systemJSPrototype.instantiate = function (id: string, parentURL: string | undefined, ...args: unknown[]) {
  //   if (id.startsWith(omsHostBaseURLPrefix)) {
  //   }
  // };
}

async function prepareInEditor(id: string, parent: string) {
  const r = require;
  const path = r('path').join(omsBaseDir, id);
  const specifier = r('url').pathToFileURL(path).href;
  const resolved = await import.meta.resolve(specifier, parent);
  return resolved;
}

async function prepareInWeb(id: string, parent) {
  void parent;
  return `/oms/${id}`;
}

export async function load(id: string, parent: string) {
  let specifier = id;
  if (EDITOR) {
    specifier = await prepareInEditor(id, parent);
  } else if (HTML5 && PREVIEW) {
    specifier = await prepareInWeb(id, parent);
  }
  await import(specifier);
}

export async function loadBundleEntry(bundleId: string, parent: string) {
  try {
    return await import(`${omsURLPrefix}bundle-${bundleId}.js`);
  } catch (err) {
    console.error(`Failed to load bundle entry: ${bundleId}, did you installed OMS extension?`);
    throw err;
  }
}

export async function loadOMSExports(id: string, parent: string) {
  const iSlash = id.indexOf('/');
  if (iSlash < 0) {
    throw new Error(`Invalid OMS exports id: ${id}`);
  }
  const domainId = id.slice(0, iSlash);
  const exportsId = id.slice(iSlash + 1);
  try {
    const exportSubpath = exportsId === '' ? '' : '/' + exportsId;
    return await import(`${omsURLPrefix}${domainId}-export${exportSubpath}.js`);
  } catch (err) {
    console.error(`Failed to load OMS exports: ${id}, did you installed OMS extension?`);
    throw err;
  }
}

export function saveRequiringFrames() {
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
