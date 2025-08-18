// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="../../../../temp/declarations/cc.env.d.ts"/>

import { HTML5, PREVIEW, EDITOR, BUILD } from 'cc/env';

let omsBaseDir = '';
const omsURLPrefix = 'oms:///';

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

  systemJSPrototype.instantiate = function (id: string, parentURL: string | undefined, ...args: unknown[]) {
    if (id.startsWith(omsBaseURL)) {
      const path = fileURLToPath(id);
      const register_vendor = systemJSPrototype.register;
      let register: unknown[] | undefined;
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
      if (!register) {
        throw new Error(`${path} does not provide a SystemJS register.`);
      }
      omsSystemInfo.instantiatedModules.push(id);
      return register;
    }
    return vendorInstantiate.call(this, id, parentURL, ...args);
  };
} else {
  const systemJSPrototype = System.constructor.prototype;

  let omsHostBaseURLPrefix = '';
  if (HTML5) {
    omsHostBaseURLPrefix = new URL('./oms/', window.location.href).href;
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
  return await import(`${omsURLPrefix}bundle-${bundleId}.js`);
}
