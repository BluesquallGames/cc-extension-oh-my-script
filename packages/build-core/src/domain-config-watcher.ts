import EventEmitter from 'node:events';
import * as chokidar from 'chokidar';
import { basename, relative, resolve } from 'node:path';
import { isOmsConfigFileName } from './config-loader.js';
import { logger } from './logger.js';
import { readOmsDomainConfig, type OmsDomainConfig } from './domain.js';
import { promiseWithResolvers } from './utils/promise-with-resolvers.js';
import type { OmsConfigContext } from './config.js';

export class OmsDomainConfigWatcher extends EventEmitter<{
  configUpdated: [config: OmsDomainConfig];
}> {
  constructor(options: {
    domainRoot: string;
    preferredSourceRoot: string;
    context: OmsConfigContext;
  }) {
    super();
    this._domainRoot = options.domainRoot;
    this._preferredSourceRoot = options.preferredSourceRoot;
    this._context = options.context;

    const readyPromiseWithResolvers = promiseWithResolvers<void>();
    this._readyPromise = readyPromiseWithResolvers.promise;

    let ready = false;
    const fsWatcher = this._fsWatcher = chokidar.watch('.', {
      cwd: this._domainRoot,
      depth: 0,
      ignoreInitial: false,
      persistent: true,
      ignored: (path, stats) => {
        if (relative(this._domainRoot, resolve(this._domainRoot, path)) === '') {
          return false;
        }
        if (stats && !stats.isFile()) {
          return true;
        }
        return !isOmsConfigFileName(basename(path));
      },
    });
    fsWatcher.on('ready', () => {
      ready = true;
      this._onAvailableConfigFilesChange(readyPromiseWithResolvers.resolve);
    });
    fsWatcher.on('add', (path) => {
      this._availableConfigFiles.add(path);
      if (ready) {
        this._onAvailableConfigFilesChange();
      }
    });
    fsWatcher.on('unlink', (path) => {
      this._availableConfigFiles.delete(path);
      if (ready) {
        this._onAvailableConfigFilesChange();
      }
    });
    fsWatcher.on('change', (path) => {
      if (this._effectiveConfigFile === path) {
        this._onEffectiveConfigFileChange();
      }
    });
    fsWatcher.on('error', (err) => {
      logger.error(`OMS domain config watcher failed for ${this._domainRoot}: %o`, err);
      readyPromiseWithResolvers.reject(err);
    });
  }

  async close() {
    await this._fsWatcher.close();
  }

  async ready(): Promise<OmsDomainConfig> {
    await this._readyPromise;
    return this._config;
  }

  private _domainRoot: string;
  private _preferredSourceRoot: string;
  private _context: OmsConfigContext;
  private _fsWatcher: chokidar.FSWatcher;
  private _readyPromise: Promise<void>;
  private _config: OmsDomainConfig = {
    partitions: [],
    exports: {},
  };
  private _effectiveConfigFile: string | undefined = undefined;
  private _availableConfigFiles: Set<string> = new Set();

  private _onAvailableConfigFilesChange(callback?: () => void) {
    const effectiveConfigFile = [...this._availableConfigFiles.values()].sort()[0] ?? '';
    if (this._effectiveConfigFile !== effectiveConfigFile) {
      this._effectiveConfigFile = effectiveConfigFile;
      this._onEffectiveConfigFileChange(callback);
    } else {
      callback?.();
    }
  }

  private _onEffectiveConfigFileChange(callback?: () => void) {
    (async () => {
      this._config = await readOmsDomainConfig(this._domainRoot, {
        preferredSourceRoot: this._preferredSourceRoot,
        configFile: this._effectiveConfigFile || null,
        context: this._context,
      });
      logger.debug('OMS domain config updated for %s: %o', this._domainRoot, this._config);
      this.emit('configUpdated', this._config);
    })().catch((err) => {
      logger.error(`Error loading OMS domain config for ${this._domainRoot}: %o`, err);
    }).finally(() => {
      callback?.();
    });
  }
}
