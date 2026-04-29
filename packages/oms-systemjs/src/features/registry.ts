import { REGISTRY, type SystemJS } from '../core.js';

const toStringTag = typeof Symbol !== 'undefined' && Symbol.toStringTag;

export class RegistryManagement {
  constructor(systemJS: SystemJS) {
    this._systemJS = systemJS;
  }

  has(id: string) {
    return this._systemJS[REGISTRY][id] !== undefined;
  }

  get(id: string) {
    const load = this._systemJS[REGISTRY][id];
    if (load && load.e === null && !load.E) {
      if (load.er) {
        return null;
      }
      return load.n;
    }
  }

  set(id: string, module: Record<string | symbol, unknown>) {
    let ns;
    if (toStringTag && module[toStringTag] === 'Module') {
      ns = module;
    } else {
      ns = Object.assign(Object.create(null), module);
      if (toStringTag)
        Object.defineProperty(ns, toStringTag, { value: 'Module' });
    }

    const done = Promise.resolve(ns);

    const load = this._systemJS[REGISTRY][id] ??= {
      id: id,
      i: [],
      h: false,
      d: [],
      e: null,
      er: undefined,
      E: undefined,
    };

    if (load.e || load.E)
      return false;

    Object.assign(load, {
      n: ns,
      I: undefined,
      L: undefined,
      C: done,
    });
    return ns;
  }

  delete(id: string) {
    const registry = this._systemJS[REGISTRY];
    const load = registry[id];
    // in future we can support load.E case by failing load first
    // but that will require TLA callbacks to be implemented
    if (!load || (load.p && load.p.e !== null) || load.E)
      return false;

    let importerSetters: typeof load.i | null = load.i;
    // remove from importerSetters
    // (release for gc)
    if (load.d)
      load.d.forEach((depLoad) => {
        // @ts-expect-error
        const importerIndex = depLoad.i.indexOf(load);
        if (importerIndex !== -1)
          depLoad.i.splice(importerIndex, 1);
      });
    delete registry[id];
    return function () {
      const load = registry[id];
      if (!load || !importerSetters || load.e !== null || load.E)
        return false;
        // add back the old setters
      importerSetters.forEach((setter) => {
        load.i.push(setter);
        setter(load.n);
      });
      importerSetters = null;
    };
  }

  entries() {
    const loader = this._systemJS;
    const keys = Object.keys(loader[REGISTRY]);
    let index = 0;
    let ns: unknown;
    let key: string;
    const result = {
      next: () => {
        while (
          (key = keys[index++]) !== undefined
          && (ns = this.get(key)) === undefined
        );
        return {
          done: key === undefined,
          value: key !== undefined && [key, ns],
        };
      },

      [Symbol.iterator]() {
        return this;
      },
    };
    return result;
  }

  private _systemJS: SystemJS;
}
