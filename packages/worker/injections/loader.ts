import { HTML5, PREVIEW, EDITOR } from 'cc/env';

let omsBaseDir = '';

if (EDITOR) {
  const r = require;
  const ps = r('path');
  const urlModule = r('url');
  omsBaseDir = ps.join(Editor.Project.tmpDir, 'oms/out', ps.sep);
  const omsBaseURL = urlModule.pathToFileURL(omsBaseDir);

  interface OmsSystemInfo {
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

  const vendorInstantiate = oldSystemInfo?.vendorInstantiate ?? systemJSPrototype.instantiate;
  const omsSystemInfo = systemJSPrototype[omsSymbol] = {
    integrity: import.meta,
    instantiatedModules: [],
    vendorInstantiate,
  } as OmsSystemInfo;
  systemJSPrototype.instantiate = function (id: string, parentURL: string | undefined, ...args: unknown[]) {
    if (id.startsWith(omsBaseURL)) {
      const path = urlModule.fileURLToPath(id);
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
