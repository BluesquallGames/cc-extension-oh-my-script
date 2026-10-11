import process from 'node:process';
/* eslint-disable @typescript-eslint/no-unused-vars */
/// Modified from https://github.com/systemjs/systemjs/blob/main/src/system-core.js

/*
 * SystemJS Core
 *
 * Provides
 * - System.import
 * - System.register support for
 *     live bindings, function hoisting through circular references,
 *     reexports, dynamic import, import.meta.url, top-level await
 * - System.getRegister to get the registration
 * - Symbol.toStringTag support in Module objects
 * - Hookable System.createContext to customize import.meta
 * - System.onload(err, id, deps) handler for tracing / hot-reloading
 *
 * Core comes with no System.prototype.resolve or
 * System.prototype.instantiate implementations
 */
import { errMsg, USE_ERROR_CODE } from './err-msg.js';

export const REGISTRY = Symbol('registry');
const toStringTag = Symbol.toStringTag;

type PromiseLike<T> = Promise<T> | T;

export type Dependencies = string[];

export interface ExportFunction {
  (name: string, value: unknown): void;
  (bindings: Record<string, unknown>): void;
}

export interface DeclareContext {
  import: (importId: string, meta?: ModuleRequestMeta) => Promise<unknown>;
  meta: unknown;
}

export type Declare = (_export: ExportFunction, context?: DeclareContext) => {
  execute: undefined | (() => PromiseLike<void>);
  setters?: ImporterSetter[];
};

export type Registration = [dependencies: Dependencies,
declare: Declare,
meta?: ModuleRequestMeta[]];

type ImporterSetter = (value: unknown) => void;

export type ModuleRequestMeta = Record<string | symbol, unknown>;

interface Load {
  id: string;

  // importerSetters, the setters functions registered to this dependency
  // we retain this to add more later
  i: ImporterSetter[];

  /**
   * module namespace object
   */
  n?: unknown;
  // extra module information for import assertion
  // shape like: { assert: { type: 'xyz' } }
  m?: unknown;

  // instantiate
  I?: undefined | Promise<unknown>;
  // link
  L?: undefined | Promise<unknown>;
  // whether it has hoisted exports
  h: boolean;

  // On instantiate completion we have populated:
  // dependency load records
  d: undefined | Load[];
  // execution function
  e: undefined | null | (() => void | Promise<void>);

  // On execution we have populated:
  // the execution error if any
  er: unknown;
  // in the case of TLA, the execution promise
  E: undefined | null | Promise<unknown>;

  // On execution, L, I, E cleared

  // Promise for top-level completion
  C?: unknown;

  // parent instantiator / executor
  p?: Load;
}

export class SystemJS {
  register(dependencies: Dependencies, declare: Declare, meta?: ModuleRequestMeta[]) {
    this._lastRegister = [dependencies, declare, meta];
  }

  /*
  * getRegister provides the last anonymous System.register call
  */
  getRegister() {
    const _lastRegister = this._lastRegister;
    this._lastRegister = undefined;
    return _lastRegister;
  }

  import(id: string, parentUrl?: string, meta?: ModuleRequestMeta) {
    return Promise.resolve(this.prepareImport())
      .then(() => {
        return this.resolve(id, parentUrl, meta);
      })
      .then((resolvedId) => {
        const load = this._getOrCreateLoad(resolvedId, undefined, meta);
        return load.C ?? this._topLevelLoad(load);
      });
  }

  prepareImport(): PromiseLike<void> {
    // nop
  }

  // Hookable createContext function -> allowing eg custom import meta
  createContext(id: string) {
    return {
      url: id,
      resolve: (id: string, parentUrl?: string) => {
        return Promise.resolve(this.resolve(id, parentUrl?.length ? parentUrl : id));
      },
    };
  }

  resolve(id: string, parentUrl?: string, meta?: ModuleRequestMeta): PromiseLike<string> {
    return id;
  }

  instantiate(id: string, parentUrl?: string, meta?: ModuleRequestMeta):
  PromiseLike<Registration | undefined> {
    return;
  }

  onload(err: unknown, id: string, deps: string[] | undefined, isErrSource: boolean) {
    // nop
  }

  [REGISTRY]: Record<string, Load> = {};

  private _lastRegister: Registration | undefined;

  private _getOrCreateLoad(id: string, firstParentUrl?: string, meta?: ModuleRequestMeta): Load {
    let load = this[REGISTRY][id];
    if (load) {
      return load;
    }

    const importerSetters: ImporterSetter[] = [];
    const ns = Object.create(null);
    if (toStringTag) {
      Object.defineProperty(ns, Symbol.toStringTag, { value: 'Module' });
    }

    const instantiatePromise = Promise.resolve()
      .then(() => {
        return this.instantiate(id, firstParentUrl, meta);
      })
      .then(
        (registration) => {
          if (!registration) {
            throw Error(errMsg(2, USE_ERROR_CODE ? id : 'Module ' + id + ' did not instantiate'));
          }
          function _export(name: string, value: unknown): void;
          function _export(bindings: Record<string, unknown>): void;

          function _export(name: string | Record<string, unknown>, value?: unknown) {
          // note if we have hoisted exports (including reexports)
            load.h = true;
            let changed = false;
            if (typeof name === 'string') {
              if (!(name in ns) || ns[name] !== value) {
                ns[name] = value;
                changed = true;
              }
            } else {
              for (const p in name) {
                const value = name[p];
                if (!(p in ns) || ns[p] !== value) {
                  ns[p] = value;
                  changed = true;
                }
              }

              if (name?.__esModule) {
                ns.__esModule = name.__esModule;
              }
            }
            if (changed) {
              for (const setter of importerSetters) {
                if (setter) {
                  setter(ns);
                }
              }
            }
            return value;
          }

          const declared = registration[1](_export, registration[1].length === 2
            ? {
              import: (importId, meta) => {
                return this.import(importId, id, meta);
              },
              meta: this.createContext(id),
            }
            : undefined);
          load.e = declared.execute ?? function () {
            // Modules without an execute hook have no execution work.
          };
          return [
            registration[0],
            declared.setters ?? [],
            registration[2] ?? [],
          ] as const;
        },
        (err) => {
          load.e = null;
          load.er = err;
          triggerOnload(this, load, err, true);
          throw err;
        });

    const linkPromise = instantiatePromise
      .then((instantiation) => {
        return Promise.all(instantiation[0].map((dep, i) => {
          const setter = instantiation[1][i];
          const meta = instantiation[2][i];
          return Promise.resolve(this.resolve(dep, id))
            .then((depId) => {
              const depLoad = this._getOrCreateLoad(depId, id, meta);
              // depLoad.I may be undefined for already-evaluated
              return Promise.resolve(depLoad.I)
                .then(() => {
                  if (setter) {
                    depLoad.i.push(setter);
                    // only run early setters when there are hoisted exports of that module
                    // the timing works here as pending hoisted export calls will trigger through
                    // importerSetters
                    if (depLoad.h || !depLoad.I) {
                      setter(depLoad.n);
                    }
                  }
                  return depLoad;
                });
            });
        }))
          .then(function (depLoads) {
            load.d = depLoads;
          });
      });

    if (!process.env.SYSTEM_BROWSER) {
      linkPromise.catch(function () {
        // The top-level import promise reports this failure to the consumer.
      });
    }

    // Capital letter = a promise function
    return load = this[REGISTRY][id] = {
      id: id,
      // importerSetters, the setters functions registered to this dependency
      // we retain this to add more later
      i: importerSetters,
      // module namespace object
      n: ns,
      // extra module information for import assertion
      // shape like: { assert: { type: 'xyz' } }
      m: meta,

      // instantiate
      I: instantiatePromise,
      // link
      L: linkPromise,
      // whether it has hoisted exports
      h: false,

      // On instantiate completion we have populated:
      // dependency load records
      d: undefined,
      // execution function
      e: undefined,

      // On execution we have populated:
      // the execution error if any
      er: undefined,
      // in the case of TLA, the execution promise
      E: undefined,

      // On execution, L, I, E cleared

      // Promise for top-level completion
      C: undefined,

      // parent instantiator / executor
      p: undefined,
    };
  }

  private _topLevelLoad(load: Load) {
    return load.C = (this._instantiateAll(load, load, {}) as Promise<unknown>)
      .then(() => {
        return this._postOrderExec(load, {});
      })
      .then(() => {
        return load.n;
      });
  }

  private _instantiateAll(load: Load, parent: Load, loaded: Record<string, boolean>):
    void | Promise<unknown> {
    if (loaded[load.id]) {
      return;
    }
    loaded[load.id] = true;
    // load.L may be undefined for already-instantiated
    return Promise.resolve(load.L)
      .then(() => {
        if (!load.p || load.p.e === null) {
          load.p = parent;
        }
        return Promise.all(load.d!.map((dep) => {
          return Promise.resolve(this._instantiateAll(dep, parent, loaded));
        }));
      })
      .catch((err) => {
        if (load.er) {
          throw err;
        }
        load.e = null;
        triggerOnload(this, load, err, false);
        throw err;
      });
  }

  // returns a promise if and only if a top-level await subgraph
  // throws on sync errors
  private _postOrderExec(load: Load, seen: Record<string, boolean>) {
    if (seen[load.id]) {
      // https://github.com/systemjs/systemjs/pull/2402
      return load.E;
    }
    seen[load.id] = true;

    if (!load.e) {
      if (load.er) {
        // JavaScript modules may throw any value; preserve its identity on re-import.
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw load.er;
      }
      if (load.E) {
        return load.E;
      }
      return;
    }

    // From here we're about to execute the load.
    // Because the execution may be async, we pop the `load.e` first.
    // So `load.e === null` always means the load has been executed or is executing.
    // To inspect the state:
    // - If `load.er` is truthy, the execution has threw or has been rejected;
    // - otherwise, either the `load.E` is a promise, means it's under async execution, or
    // - the `load.E` is null, means the load has completed the execution or has been async
    // resolved.
    const exec = load.e;
    load.e = null;

    // deps execute first, unless circular
    let depLoadPromises: undefined | Array<Promise<unknown>>;
    load.d!.forEach((depLoad) => {
      try {
        const depLoadPromise = this._postOrderExec(depLoad, seen);
        if (depLoadPromise) {
          (depLoadPromises ??= []).push(depLoadPromise);
        }
      } catch (err) {
        load.er = err;
        triggerOnload(this, load, err, false);
        throw err;
      }
    });

    const doExec = () => {
      try {
        let execPromise = exec.call(nullContext);
        if (execPromise) {
          execPromise = execPromise.then(
            () => {
              load.C = load.n;
              triggerOnload(this, load, null, true);
            },
            (err) => {
              load.er = err;
              triggerOnload(this, load, err, true);
              throw err;
            });
          return execPromise;
        }
        // (should be a promise, but a minify optimization to leave out Promise.resolve)
        load.C = load.n;
        load.L = load.I = undefined;
      } catch (err) {
        load.er = err;
        throw err;
      } finally {
        triggerOnload(this, load, load.er, true);
      }
    };

    if (depLoadPromises) {
      return load.E = Promise.all(depLoadPromises).then(doExec).finally(() => {
        load.E = null;
      });
    }

    const execPromise = doExec();
    if (execPromise) {
      return load.E = execPromise.finally(() => {
        load.E = null;
      });
    }
  }
}

function loadToId(load: Load) {
  return load.id;
}

function triggerOnload(loader: SystemJS, load: Load, err: unknown, isErrSource: boolean) {
  loader.onload(err, load.id, load.d?.map(loadToId), !!isErrSource);
  if (err) {
    // Forward the module's original thrown value through the loader hooks.
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw err;
  }
}

// the closest we can get to call(undefined)
const nullContext = Object.freeze(Object.create(null));
