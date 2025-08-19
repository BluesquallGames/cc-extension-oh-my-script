import { join, parse, resolve } from 'node:path';
import fs from 'fs-extra';
import { logger } from './logger.js';
import { ServerContext } from './server-context.js';
import * as rollup from 'rollup';
import rollupPluginCommonJS_ from '@rollup/plugin-commonjs';
import rollupPluginNodeResolve_ from '@rollup/plugin-node-resolve';
import rollupPluginBabel_ from '@rollup/plugin-babel';
// @ts-expect-error
import babelPluginProposalDecorators from '@babel/plugin-proposal-decorators';
import babelPresetEnv from '@babel/preset-env';
// @ts-expect-error
import babelPresetTypescript from '@babel/preset-typescript';
import * as chokidar from 'chokidar';
import { transformCCComponent, type UUIDProvider } from './features/babel-plugin-cc-component.js';
import assert from 'node:assert';
import { extractInlineUUID, UUIDManager, writeInlineUUID } from './uuid-manager.js';
import { format } from 'node:util';
import { rollupPluginWasm } from './features/rollup-plugin-wasm.js';
import { makeFileSystemAbsoluteImportSpecifier } from './utils/import-specifier.js';
import type { InvocationParams } from './protocol.js';
import { promiseWithResolvers, type PromiseWithResolvers } from './utils/promise-with-resolvers.js';
import Ejs from 'ejs';
import { helpersDir } from './helpers-dir.js';
import { rollupPluginMemoryModules } from './features/rollup-plugin-memory-modules.js';
import { generateCCEnvModuleSource, type CCEnvParams } from './features/generate-cc-env.js';

const rollupPluginCommonJS = rollupPluginCommonJS_ as unknown as typeof rollupPluginCommonJS_.default;
const rollupPluginNodeResolve = rollupPluginNodeResolve_ as unknown as typeof rollupPluginNodeResolve_.default;
const rollupPluginBabel = rollupPluginBabel_ as unknown as typeof rollupPluginBabel_.default;

const mainBundleId = 'main';

export class OmsBuilder {
  constructor(private _ctx: ServerContext, {
    project,
  }: {
    project: string;
  }) {
    this._projectPath = project;
  }

  async rebuild() {
    await this._rebuild();
  }

  async inlineUUIDs() {
    await this._watcher?.inlineUUIDs();
  }

  async buildProd(opts: InvocationParams<'build-prod'>) {
    await this._watcher?.buildProd(opts);
  }

  private _projectPath: string;
  private _watcher: OmsWatcher | undefined;

  private async _clean() {
    const watcher = this._watcher;
    if (watcher) {
      this._watcher = undefined;
      await watcher.close();
    }
  }

  private async _rebuild() {
    await this._clean();

    const outDir = resolve(this._projectPath, 'temp', 'oms', 'out');
    await fs.ensureDir(outDir);
    await fs.emptyDir(outDir);
    await fs.outputJSON(join(outDir, 'package.json'), {
      type: 'module',
    }, {
      spaces: 2,
    });

    assert(!this._watcher);
    this._watcher = new OmsWatcher({
      projectPath: this._projectPath,
      outDir,
      ctx: this._ctx,
    });
    await this._watcher.start();
  }
}

class OmsWatcher {
  constructor(options: {
    projectPath: string;
    outDir: string;
    ctx: ServerContext;
  }) {
    const {
      projectPath,
      outDir,
      ctx,
    } = options;

    this._projectPath = projectPath;
    this._outDir = outDir;
    this._mainBundleSourceRoot = join(projectPath, 'src');
    this._ctx = ctx;

    const buildRecord = new BuildRecord({
      outDir,
    });
    this._buildRecord = buildRecord;

    const mainBundle = new Bundle(mainBundleId, this._mainBundleSourceRoot, resolve(projectPath, 'assets/oms-index.ts'));
    this._bundles[mainBundle.id] = mainBundle;

    const uuidManager = new UUIDManager(this._projectPath);
    this._uuidManager = uuidManager;

    const uuidProvider = uuidManager.get.bind(uuidManager);
    this._uuidProvider = uuidProvider;

    const watcher = chokidar.watch(this._mainBundleSourceRoot, {
      ignored: (path, stats) => {
        if (stats?.isFile()) {
          if (/\.[mc]?[jt]s$/.test(path.toLocaleLowerCase())) {
            return false;
          }
          return true;
        }
        return false;
      },
      persistent: true,
    });
    this._fileWatcher = watcher;
    watcher
      .on('ready', () => {
        logger.debug('Watcher ready');
        this._fileWatcherReady = true;
        this._queueBuild();
      })
      .on('error', (error) => {
        logger.error('Watcher error: %s', error);
      })
      .on('all', (event, path) => {
        logger.debug('Watcher event: %s, Path: %s', event, path);
      })
      .on('add', (path) => {
        if (this._passiveWatchedFiles.has(path)) {
          return;
        }
        this._fileQueue[path] = 'add';
        this._queueBuild();
      })
      .on('change', (path) => {
        this._queueBuild();
      })
      .on('unlink', (path) => {
        this._fileQueue[path] = 'delete';
        this._queueBuild();
      })
      .on('addDir', (path) => {
        void 0;
      })
      .on('unlinkDir', (path) => {
        void 0;
      })
    ;
  }

  async start() {
    await this._loadCentralizedUUIDs();
  }

  async close() {
    await this._fileWatcher.close();
    this._taskQueue.length = 0;
    await this._runningPromise;
  }

  async inlineUUIDs() {
    await this._queueTask({
      type: 'inlineUUIDs',
      exec: async () => {
        await this._execInlineUUIDs();
      },
    });
  }

  async buildProd(opts: InvocationParams<'build-prod'>) {
    logger.debug(`Performing production build. Options: %o`, opts);

    const outDir = join(opts.buildDir, 'oms');

    const buildRecord = new BuildRecord({
      outDir,
      sourceMaps: opts.sourceMaps,
      debug: opts.debug,
      ccEnvParams: {
        platform: opts.platform,
        mode: 'BUILD',
        debug: opts.debug,
      },
    });

    await this._queueTask({
      type: 'build-prod',

      exec: async () => {
        const bundles = this._bundles;

        const bundleEntries: Record<string, string> = {};
        for (const [bundleId, bundle] of Object.entries(bundles)) {
          if (bundle.empty) {
            continue;
          }
          bundleEntries[this._makeBundleEntryFilenameNoExtension(bundleId)] = bundle.entry;
        }

        await buildRecord.rebuild({
          entries: bundleEntries,
          uuidProvider: this._uuidProvider,
        });
      },
    });
  }

  private _projectPath: string;
  private _outDir: string;
  private _mainBundleSourceRoot: string;
  private _ctx: ServerContext;
  private _uuidManager: UUIDManager;
  private _uuidProvider: UUIDProvider;
  private _buildRecord: BuildRecord;
  private _fileWatcher: chokidar.FSWatcher;
  private _fileWatcherReady = false;
  private _passiveWatchedFiles = new Set<string>();
  private _nBuildEnds = 0;
  private _bundles: Record<string, Bundle> = {};
  private _taskQueue: (OmsWatcherTask & {
    execPromiseWithResolvers: PromiseWithResolvers<void>;
  })[] = [];

  private _runningPromise: Promise<void> | undefined;
  private _fileQueue: Record<string, 'add' | 'delete'> = {};
  private _lastBuildExtras: BuildExtras | undefined;

  private _queueTask<TTask extends OmsWatcherTask>(task: TTask) {
    for (const pendingTask of this._taskQueue) {
      if (pendingTask.type === task.type) {
        logger.debug(`Task [${task.type}] was pending, merged.`);
        return pendingTask.execPromiseWithResolvers.promise;
      }
    }
    logger.debug(`Queue task: [${task.type}]`);
    const execPromiseWithResolvers = promiseWithResolvers<void>();
    this._taskQueue.push({
      ...task,
      execPromiseWithResolvers: execPromiseWithResolvers,
    });
    if (!this._runningPromise) {
      logger.debug(`Start execute task queue`);
      this._executeTasks();
    }
    return execPromiseWithResolvers.promise;
  }

  private _executeTasks() {
    assert.ok(!this._runningPromise);
    const tasks = this._taskQueue.slice();
    this._taskQueue.length = 0;
    this._runningPromise = (async () => {
      for (const task of tasks) {
        try {
          logger.debug(`Execute task: [${task.type}]`);
          await task.exec();
          task.execPromiseWithResolvers.resolve();
          logger.debug(`Task [${task.type}] done`);
        } catch (err) {
          logger.debug(`Task [${task.type}] failed`);
          logger.error(err);
          task.execPromiseWithResolvers.reject(err);
        }
      }
    })()
      .catch((err) => {
        logger.error(err);
      })
      .finally(() => {
        this._runningPromise = undefined;
        if (this._taskQueue.length !== 0) {
          this._executeTasks();
        } else {
          logger.debug('Task queue empty, idling.');
        }
      });
  }

  private _getBundleId(path: string): string | undefined {
    return mainBundleId;
  }

  private _queueBuild() {
    if (!this._fileWatcherReady) {
      return;
    }
    this._queueTask({
      type: 'build',
      exec: async () => {
        await this._execBuild();
      },
    }).catch((err) => {
      logger.error(err);
    });
  }

  private async _execBuild() {
    try {
      const [buildResult, buildExtras] = await this._doExecBuild();
      if (buildResult.ok) {
        await this._onBuildEnd(buildResult.buildResult, buildExtras);
      } else {
        await this._ctx.ipc.invoke('build-failed', {
          message: buildResult.message,
          stack: buildResult.stack,
        });
      }
    } catch (err) {
      await this._ctx.ipc.invoke('build-failed', {
        message: format('%o', err),
      });
    }
  }

  private async _doExecBuild() {
    const entryChanged = await this._executeFileQueue();

    if (this._lastBuildExtras) {
      if (!entryChanged) {
        return [await this._buildRecord.build(), this._lastBuildExtras] as const;
      }
    }

    this._lastBuildExtras = undefined;

    const bundleEntries: Record<string, string> = {};
    const buildExtras: BuildExtras = {
      bundles: [],
      entryFiles: new Set(),
    };
    for (const [bundleId, bundle] of Object.entries(this._bundles)) {
      if (bundle.empty) {
        continue;
      }
      bundleEntries[this._makeBundleEntryFilenameNoExtension(bundleId)] = bundle.entry;
      buildExtras.bundles.push(bundle);
      for (const file of bundle.entryFiles()) {
        buildExtras.entryFiles.add(file);
      }
    }

    this._lastBuildExtras = buildExtras;
    return [
      await this._buildRecord.rebuild({
        entries: bundleEntries,
        uuidProvider: this._uuidProvider,
      }),
      buildExtras,
    ] as const;
  }

  private async _onBuildEnd(buildResult: BuildResult, extras: BuildExtras) {
    this._nBuildEnds++;

    const affectedFiles: string[] = [];
    for (const bundle of extras.bundles) {
      const proxyFile = bundle.proxyFile;
      const bundleEntryOutFile = resolve(this._outDir, `${this._makeBundleEntryFilenameNoExtension(bundle.id)}.js`);
      const proxyFileContent = await this._renderProxyFile(proxyFile, bundleEntryOutFile, bundle.id);
      await fs.outputFile(proxyFile, proxyFileContent, 'utf8');
      affectedFiles.push(proxyFile);
    }
    this._ctx.ipc.invoke('build-success', {
      affectedFiles: [...affectedFiles],
    }).catch((err) => {
      logger.error(err);
    });

    logger.debug(`[Build x ${this._nBuildEnds}] Build end, inferred files: %s`, buildResult.inferredFiles);
    const passiveWatchedFiles = this._passiveWatchedFiles;
    const watcher = this._fileWatcher;
    for (const file of passiveWatchedFiles) {
      if (!buildResult.inferredFiles.includes(file)) {
        logger.debug('Unwatch file: %s', file);
        watcher.unwatch(file);
      }
    }
    for (const file of buildResult.inferredFiles) {
      if (passiveWatchedFiles.has(file)) {
        continue;
      }
      if (extras.entryFiles.has(file)) {
        continue;
      }
      logger.debug('Passive watch file: %s', file);
      watcher.add(file);
      passiveWatchedFiles.add(file);
    }

    await this._saveCentralizedUUIDs();
  }

  private _makeBundleEntryFilenameNoExtension(bundleId: string) {
    return `bundle-${bundleId}`;
  }

  private async _renderProxyFile(proxyFilePath: string, bundleEntryPath: string, bundleId: string) {
    const template = await fs.readFile(join(helpersDir, 'proxy.ts.ejs'), 'utf8');
    const source = Ejs.render(template, {
      bundleId,
    });
    return source;
  }

  private async _loadCentralizedUUIDs() {
    await this._uuidManager.loadCentralized(this._getCentralizedUUIDMappingPath());
  }

  private async _saveCentralizedUUIDs() {
    await this._uuidManager.saveCentralized(this._getCentralizedUUIDMappingPath());
  }

  private _getCentralizedUUIDMappingPath() {
    return join(this._projectPath, 'oms', 'uuids.json');
  }

  private async _executeFileQueue() {
    const fileQueue = this._fileQueue;
    this._fileQueue = {};
    let entryChanged = false;
    for (const [file, operation] of Object.entries(fileQueue)) {
      if (operation === 'add') {
        entryChanged = (await this._addWatchFile(file)) || entryChanged;
      } else {
        entryChanged = (await this._removeWatchFile(file)) || entryChanged;
      }
    }
    return entryChanged;
  }

  private async _addWatchFile(path: string) {
    const bundleId = this._getBundleId(path);
    if (!bundleId) {
      return false;
    }
    const bundle = this._bundles[bundleId];
    assert.ok(bundle, `Bundle ${bundleId} not found`);
    let shouldRebuildBundle = false;
    if (this._isComponentModule(bundle, path)) {
      try {
        await this._ensureUUID(path);
      } catch (err) {
        logger.error(`Failed to assign UUID for ${path}: %o`, err);
      }
      shouldRebuildBundle = bundle.addComponentModule(path) || shouldRebuildBundle;
    } else if (this._isIndexModule(bundle, path)) {
      shouldRebuildBundle = bundle.addIndexModule(path) || shouldRebuildBundle;
    }
    return shouldRebuildBundle;
  }

  private async _ensureUUID(module: string) {
    const code = await fs.readFile(module, 'utf8');
    const inlineUUID = extractInlineUUID(code) ?? '';
    this._uuidManager.update(module, inlineUUID);
  }

  private _removeWatchFile(path: string) {
    const bundleId = this._getBundleId(path);
    if (!bundleId) {
      return false;
    }
    const bundle = this._bundles[bundleId];
    assert.ok(bundle, `Bundle ${bundleId} not found`);
    let shouldRebuildBundle = false;
    if (this._isComponentModule(bundle, path)) {
      this._uuidManager.delete(path);
      shouldRebuildBundle = bundle.deleteComponentModule(path) || shouldRebuildBundle;
    } else if (this._isIndexModule(bundle, path)) {
      shouldRebuildBundle = bundle.deleteIndexModule(path) || shouldRebuildBundle;
    }
    return shouldRebuildBundle;
  }

  private _isComponentModule(bundle: Bundle, path: string) {
    void bundle;
    return /\.component\.[cm]?[jt]s$/.test(path.toLocaleLowerCase());
  }

  private _isIndexModule(bundle: Bundle, path: string) {
    const { dir, name, ext } = parse(path);
    return dir === bundle.sourceRoot
      && /^\.[cm]?[jt]s$/.test(ext.toLowerCase())
      && name.toLocaleLowerCase() === 'index';
  }

  private async _execInlineUUIDs() {
    for (const [file, uuid] of this._uuidManager.centralizedModules()) {
      let code = '';
      try {
        code = await fs.readFile(file, 'utf8');
      } catch (err) {
        logger.error(`Failed to read file ${file}: %o`, err);
        continue;
      }
      const newCode = writeInlineUUID(code, uuid);
      try {
        await fs.writeFile(file, newCode, 'utf8');
      } catch (err) {
        logger.error(`Failed to write file ${file}: %o`, err);
        continue;
      }
      this._uuidManager.update(file, uuid);
    }
    await this._saveCentralizedUUIDs();
  }
}

function* listEntries(sourceRoot: string) {
  if (!fs.existsSync(sourceRoot)) {
    return;
  }
  for (const entry of readDirRecurse(sourceRoot)) {
    if (/\.[cm]?[jt]s$/.test(entry)) {
      yield join(sourceRoot, entry);
    }
  }
}

type OmsWatcherTask = {
  type: 'build';
  exec: () => Promise<void>;
} | {
  type: 'rebuild';
  exec: () => Promise<void>;
} | {
  type: 'inlineUUIDs';
  exec: () => Promise<void>;
} | {
  type: 'build-prod';
  exec: () => Promise<void>;
};

interface BuildExtras {
  bundles: Bundle[];
  entryFiles: Set<string>;
}

function* readDirRecurse(root: string, current: string = ''): Generator<string> {
  const path = resolve(root, current);
  const stat = fs.statSync(path);
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(path)) {
      yield * readDirRecurse(root, join(current, entry));
    }
  } else {
    yield current;
  }
}

class Bundle {
  constructor(private _id: string, private _sourceRoot: string, private _proxyFile: string) {
  }

  get empty() {
    return !this._indexModule && this._componentModules.length === 0;
  }

  get id() {
    return this._id;
  }

  get sourceRoot() {
    return this._sourceRoot;
  }

  get entry() {
    if (this._entryDirty) {
      this._entrySource = this._makeEntrySource();
      this._entryDirty = false;
    }
    return this._entrySource;
  }

  get proxyFile() {
    return this._proxyFile;
  }

  entryFiles() {
    const files: string[] = [];
    if (this._indexModule) {
      files.push(this._indexModule);
    }
    files.push(...this._componentModules);
    return files;
  }

  addComponentModule(sourceFile: string) {
    if (this._componentModules.includes(sourceFile)) {
      return false;
    }
    this._componentModules.push(sourceFile);
    this._invalidateEntry();
    return true;
  }

  deleteComponentModule(sourceFile: string) {
    const componentModuleIndex = this._componentModules.findIndex((m) => m === sourceFile);
    if (componentModuleIndex < 0) {
      return false;
    }
    this._componentModules.splice(componentModuleIndex, 1);
    this._invalidateEntry();
    return true;
  }

  addIndexModule(sourceFile: string) {
    if (this._indexModule === sourceFile) {
      return false;
    }
    this._indexModule = sourceFile;
    this._invalidateEntry();
    return true;
  }

  deleteIndexModule(sourceFile: string) {
    if (this._indexModule !== sourceFile) {
      return false;
    }
    this._indexModule = '';
    this._invalidateEntry();
    return true;
  }

  private _indexModule = '';
  private _componentModules: string[] = [];
  private _entryDirty = true;
  private _entrySource = '';

  private _invalidateEntry() {
    this._entryDirty = true;
    this._entrySource = '';
  }

  private _makeEntrySource() {
    let source = '';
    if (this._indexModule) {
      source
        += `/// The index module.\n`
          + `import '${makeFileSystemAbsoluteImportSpecifier(this._indexModule)}';\n`;
    }
    for (const componentModule of this._componentModules) {
      source += `import '${makeFileSystemAbsoluteImportSpecifier(componentModule)}';\n`;
    }
    // Explicitly mark this as a module.
    source += `export {};\n`;
    return source;
  }
}

interface InternalBuildOptions {
  entries: Record<string, string>;
  uuidProvider: UUIDProvider | undefined;
}

interface BuildResult {
  inferredFiles: string[];
}

class BuildRecord {
  constructor(options: {
    outDir: string;
    sourceMaps?: boolean | 'inline';
    debug?: boolean;
    ccEnvParams?: CCEnvParams;
  }) {
    this._outDir = options.outDir;
    this._sourceMaps = options.sourceMaps ?? true;
    this._debug = options.debug ?? true;
    this._ccEnvParams = options.ccEnvParams;
  }

  async rebuild(options: InternalBuildOptions) {
    Object.assign(this._buildOptions, options);
    return await this.build();
  }

  async build(): Promise<{
    ok: true;
    buildResult: BuildResult;
  } | {
    ok: false;
    message: string;
    stack?: string;
  }> {
    try {
      const {
        entries,
        ...passthroughBuildOptions
      } = this._buildOptions;
      const buildResult = await this._doBuild({
        entries: { ...entries },
        ...passthroughBuildOptions,
      });
      return {
        ok: true,
        buildResult,
      };
    } catch (error) {
      logger.debug('Build failed: %o', error);
      let message = '';
      let stack: string | undefined;
      if (error instanceof Error) {
        if (error instanceof Error && error.name === 'RollupError') {
          const rollupError = error as rollup.RollupError;
          message = rollupError.message;
        } else {
          message = error.message;
        }
        stack = error.stack;
      } else {
        message = String(error);
      }
      return {
        ok: false,
        message,
        stack,
      };
    }
  }

  private _cache: rollup.RollupCache | undefined;
  private _outDir: string;
  private _sourceMaps: boolean | 'inline';
  private _debug: boolean;
  private _ccEnvParams: CCEnvParams | undefined;
  private _buildOptions: InternalBuildOptions = {
    entries: {},
    uuidProvider: undefined,
  };

  private async _doBuild(options: InternalBuildOptions): Promise<BuildResult> {
    const entries = options.entries;
    if (Object.keys(entries).length === 0) {
      logger.debug('No entry found, skip build');
      this._cache = undefined;
      return {
        inferredFiles: [],
      };
    }

    const mainPart = await this._doBuildUnchecked(options);
    return mainPart;
  }

  private async _doBuildUnchecked(options: InternalBuildOptions): Promise<BuildResult> {
    const {
      entries,
    } = options;

    const ENTRY_MODULE_PREFIX = 'oms-entry\0';

    const rollupEntries: Record<string, string> = {};
    for (const key of Object.keys(entries)) {
      rollupEntries[key] = ENTRY_MODULE_PREFIX + key;
    }

    const memoryModules: Record<string, string> = {};
    const externals: string[] = [
      'cc',
    ];

    if (this._ccEnvParams) {
      const ccEnvMouseSource = memoryModules['cc/env'] = generateCCEnvModuleSource({
        params: this._ccEnvParams,
      });
      logger.debug('"cc/env" source: %s', ccEnvMouseSource);
    } else {
      externals.push('cc/env');
    }

    const inputPlugins: rollup.Plugin[] = [
      {
        name: 'oms:load-entry-modules',

        resolveId(id, parent, info) {
          if (info.isEntry && id.startsWith(ENTRY_MODULE_PREFIX)) {
            return id;
          }
          return undefined;
        },

        load(id) {
          if (id.startsWith(ENTRY_MODULE_PREFIX)) {
            const entryModuleId = id.slice(ENTRY_MODULE_PREFIX.length);
            const entryModuleSource = entries[entryModuleId];
            if (entryModuleSource === undefined) {
              this.error(`Unknown entry module ${entryModuleId}, where'd it import?`);
            } else {
              return entryModuleSource;
            }
          }
          return undefined;
        },
      },

      rollupPluginMemoryModules({
        modules: memoryModules,
      }),

      rollupPluginWasm({}),

      rollupPluginCommonJS({
        extensions: [
          '.js',
          '.cjs',
        ],
      }),

      rollupPluginNodeResolve({
        extensions: [
          '.js',
          '.mjs',
          '.cjs',
          '.ts',
          '.mts',
          '.cts',
        ],
        allowExportsFolderMapping: false,
        preferBuiltins: false,
      }),

      this._makeRollupBabelPlugin({
        uuidProvider: options.uuidProvider,
        decorators: true,
      }),
    ];

    const rollupBuild = await rollup.rollup({
      cache: this._cache,
      input: rollupEntries,
      external(source, importer, isResolved) {
        if (externals.includes(source)) {
          return true;
        }
        return false;
      },
      plugins: inputPlugins,
    });

    this._cache = rollupBuild.cache;

    const outputPlugins: rollup.Plugin[] = [
    ];

    const outputOptions: rollup.OutputOptions = {
      dir: join(this._outDir),
      format: 'systemjs',
      entryFileNames: '[name].js',
      chunkFileNames: '_chunks/[name]-[hash].js',
      assetFileNames: '_assets/[name]-[hash][extname]',
      sourcemap: this._sourceMaps,
      plugins: outputPlugins,
      manualChunks(id) {
        if (id.includes('node_modules')) {
          return 'vendor';
        }
        return null;
      },
    };

    await rollupBuild.write(outputOptions);

    return {
      inferredFiles: rollupBuild.watchFiles,
    };
  }

  private _makeRollupBabelPlugin({
    decorators,
    uuidProvider,
  }: {
    decorators?: boolean;
    uuidProvider?: UUIDProvider;
  }) {
    return rollupPluginBabel({
      extensions: [
        '.js',
        '.mjs',
        '.cjs',
        '.ts',
        '.mts',
        '.cts',
      ],
      babelHelpers: 'bundled',
      babelrc: false,
      skipPreflightCheck: true,
      plugins: [
        uuidProvider
          ? [transformCCComponent({
            uuidProvider,
          })]
          : undefined,
        decorators
          ? [babelPluginProposalDecorators, {
            version: 'legacy',
          }]
          : undefined,
      ].filter((p) => !!p),
      presets: [
        [babelPresetEnv, {
          modules: false,
          targets: {
            node: '14',
          },
          include: [
            decorators ? '@babel/plugin-transform-class-properties' : undefined,
          ].filter((p): p is string => !!p),
        } satisfies babelPresetEnv.Options],
        [babelPresetTypescript, {

        }],
      ],
    });
  }
}
