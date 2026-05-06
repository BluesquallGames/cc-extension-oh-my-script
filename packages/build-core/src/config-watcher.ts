import EventEmitter from 'node:events';
import * as chokidar from 'chokidar';
import { normalizeUserConfig, type OmsConfig, type OmsUserConfig } from './config.js';
import { promiseWithResolvers } from './utils/promise-with-resolvers.js';
import { logger } from './logger.js';
import { basename, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export class OmsConfigWatcher extends EventEmitter<{
  configUpdated: [config: OmsConfig];
}> {
  constructor(options: {
    projectPath: string;
    once?: boolean;
  }) {
    super();
    const readyPromiseWithResolvers = promiseWithResolvers<void>();
    this._readyPromise = readyPromiseWithResolvers.promise;
    const rootDir = options.projectPath;
    this._rootDir = rootDir;
    let ready = false;
    const fsWatcher = this._fsWatcher = chokidar.watch('.', {
      ignoreInitial: false,
      persistent: !options.once,
      cwd: options.projectPath,
      ignored: (path, stats) => {
        if (relative(rootDir, path) === '') {
          return false;
        }
        if (stats && !stats.isFile()) {
          return true;
        }
        const name = basename(path);
        return !/^oms\.config\.[cm]?js$/.test(name);
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
      readyPromiseWithResolvers.reject(err);
    });
  }

  async close() {
    await this._fsWatcher.close();
  }

  async ready(): Promise<OmsConfig> {
    await this._readyPromise;
    return this._config;
  }

  private _config: OmsConfig = normalizeUserConfig({});

  private _rootDir: string;
  private _fsWatcher: chokidar.FSWatcher;
  private _readyPromise: Promise<void>;
  private _effectiveConfigFile = '';
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
    const path = resolve(this._rootDir, this._effectiveConfigFile);
    (async () => {
      const { default: config } = await import(pathToFileURL(path).href + '?timestamp=' + Date.now());
      let useConfig: OmsUserConfig;
      if (typeof config === 'function') {
        useConfig = config();
      } else {
        useConfig = config;
      }
      logger.debug('user config read: %o', useConfig);
      this._config = normalizeUserConfig(useConfig);
      logger.debug('config updated: %o', this._config);
      this.emit('configUpdated', this._config);
    })().catch((err) => {
      logger.error(`Error loading config file ${path}: %o`, err);
    }).finally(() => {
      callback?.();
    });
  }
}
