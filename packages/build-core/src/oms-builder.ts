import { join, parse, resolve } from 'node:path';
import fs from 'fs-extra';
import { logger } from './logger.js';
import { ServerContext } from './server-context.js';
import * as rollup from 'rollup';
import rollupPluginCommonJS_ from '@rollup/plugin-commonjs';
import rollupPluginNodeResolve_ from '@rollup/plugin-node-resolve';
import rollupPluginBabel_ from '@rollup/plugin-babel';
import rollupPluginJson_ from '@rollup/plugin-json';
// @ts-expect-error
import babelPluginProposalDecorators from '@babel/plugin-proposal-decorators';
import babelPresetEnv from '@babel/preset-env';
// @ts-expect-error
import babelPresetTypescript from '@babel/preset-typescript';
import * as chokidar from 'chokidar';
import { transformCCComponent, type UUIDProvider } from './features/babel-plugin-cc-component.js';
import assert from 'node:assert';
import { UUIDManager, writeInlineUUID } from './uuid-manager.js';
import { format } from 'node:util';
import { rollupPluginWasm } from './features/rollup-plugin-wasm.js';
import type { BuildOptions, InvocationParams } from './protocol.js';
import { promiseWithResolvers, type PromiseWithResolvers } from './utils/promise-with-resolvers.js';
import Ejs from 'ejs';
import { helpersDir } from './helpers-dir.js';
import { rollupPluginMemoryModules } from './features/rollup-plugin-memory-modules.js';
import { generateCCEnvModuleSource, type CCEnvParams } from './features/generate-cc-env.js';
import { Domain, readDomainExports, type BundleEntrySpec } from './domain.js';

const rollupPluginCommonJS = rollupPluginCommonJS_ as unknown as typeof rollupPluginCommonJS_.default;
const rollupPluginNodeResolve = rollupPluginNodeResolve_ as unknown as typeof rollupPluginNodeResolve_.default;
const rollupPluginBabel = rollupPluginBabel_ as unknown as typeof rollupPluginBabel_.default;
const rollupPluginJson = rollupPluginJson_ as unknown as typeof rollupPluginJson_.default;

const mainBundleId = 'main';
const mainDomainId = 'main';

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

  async updateBuildOptions(opts: BuildOptions) {
    this._buildOptions = opts;
    if (this._watcher) {
      await this._watcher.updateBuildOptions(opts);
    }
  }

  async inlineUUIDs() {
    await this._watcher?.inlineUUIDs();
  }

  async buildProd(opts: InvocationParams<'build-prod'>) {
    await this._watcher?.buildProd(opts);
  }

  private _projectPath: string;
  private _watcher: OmsWatcher | undefined;
  private _buildOptions: BuildOptions = {
    extensionBuildOptions: [],
  };

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
      buildOptions: this._buildOptions,
    });
    await this._watcher.start();
  }
}

class OmsWatcher {
  constructor(options: {
    projectPath: string;
    outDir: string;
    ctx: ServerContext;
    buildOptions: BuildOptions;
  }) {
    const {
      projectPath,
      outDir,
      ctx,
      buildOptions,
    } = options;

    this._projectPath = projectPath;
    this._buildOptions = buildOptions;
    this._outDir = outDir;
    this._mainBundleProjectSourceRoot = join(projectPath, 'src');
    this._ctx = ctx;

    const buildRecord = new BuildRecord({
      outDir,
    });
    this._buildRecord = buildRecord;

    const uuidManager = new UUIDManager(this._projectPath);
    this._uuidManager = uuidManager;

    const uuidProvider = uuidManager.get.bind(uuidManager);
    this._uuidProvider = uuidProvider;

    const watcher = chokidar.watch(this._mainBundleProjectSourceRoot, {
      ignored: (path, stats) => {
        if (stats?.isFile()) {
          if (/\.[mc]?[jt]sx?$/.test(path.toLocaleLowerCase())) {
            return false;
          }
          if (/.jsonc?$/.test(path.toLocaleLowerCase())) {
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
        switch (this._fileQueue[path]) {
        case 'add':
        case 'delete':
          return;
        }
        this._fileQueue[path] = 'change';
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
    await this._updateDomains();
    await this._loadCentralizedUUIDs();
  }

  async close() {
    await this._fileWatcher.close();
    this._taskQueue.length = 0;
    await this._runningPromise;
  }

  async updateBuildOptions(options: BuildOptions) {
    await this._queueTask({
      type: 'update-build-options',
      exec: async () => {
        this._buildOptions = options;
        await this._updateDomains();
      },
    });
    this._queueBuild();
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
        const {entries, autoRunInfos} = this._makeEntries();
        await buildRecord.rebuild({
          entries,
          uuidProvider: this._uuidProvider,
        });
      },
    });
  }

  private _projectPath: string;
  private _buildOptions: Readonly<BuildOptions>;

  private _outDir: string;
  private _mainBundleProjectSourceRoot: string;
  private _ctx: ServerContext;
  private _uuidManager: UUIDManager;
  private _uuidProvider: UUIDProvider;
  private _buildRecord: BuildRecord;
  private _fileWatcher: chokidar.FSWatcher;
  private _fileWatcherReady = false;
  private _passiveWatchedFiles = new Set<string>();
  private _nBuildEnds = 0;
  private _domains: Record<string, Domain> = {};
  private _domainSourceRootMap: Array<{
    domainId: string;
    sourceRoot: string;
  }> = [];
  private _taskQueue: (OmsWatcherTask & {
    execPromiseWithResolvers: PromiseWithResolvers<void>;
  })[] = [];

  private _runningPromise: Promise<void> | undefined;
  private _fileQueue: Record<string, 'add' | 'delete' | 'change'> = {};
  private _lastBuildExtras: BuildExtras | undefined;

  private async _updateDomains() {
    this._domains = {};
    this._domainSourceRootMap.length = 0;
    const domainPromises: Promise<void>[] = [];
    const mainDomainRoot = join(this._projectPath);
    domainPromises.push(this._addDomain(
      mainDomainId, mainDomainRoot, join(mainDomainRoot, 'oms/src'),
    ));
    for (const {name: extensionName, path: extensionPath} of this._buildOptions.extensionBuildOptions) {
      const extensionDomainRoot = join(extensionPath);
      domainPromises.push(this._addDomain(
        extensionName, extensionDomainRoot, join(extensionDomainRoot, 'oms/src'),
      ));
    }
    await Promise.all(domainPromises);
  }

  private async _addDomain(domainId: string, domainRoot: string, domainSourceRoot: string) {
    const domainExports = await readDomainExports(domainRoot, domainSourceRoot);
    this._domains[domainId] = new Domain(
      domainId,
      domainRoot,
      domainSourceRoot,
      domainExports,
      this._uuidManager,
    );
    this._domainSourceRootMap.push({
      domainId,
      sourceRoot: domainSourceRoot,
    });
    this._domainSourceRootMap.sort((a, b) => b.sourceRoot.length - a.sourceRoot.length);
    this._fileWatcher.add(domainSourceRoot);
  }

  private _makeEntries() {
    const entries: Record<string, string> = {};
    const autoRunInfos: Array<{
      entryId: string;
      bundleId: string;
    }> = [];
    for (const [domainId, domain] of Object.entries(this._domains)) {
      const domainEntrySpecs = domain.getEntrySpecs();
      for (const [domainEntrySpecId, domainEntrySpec] of Object.entries(domainEntrySpecs)) {
        if (domainEntrySpecId in entries) {
          logger.warn(`Duplicate entry spec id: ${domainEntrySpecId}`);
          continue;
        }
        entries[domainEntrySpecId] = domainEntrySpec.source;
        if (domainEntrySpec.autoRun) {
          autoRunInfos.push({
            entryId: domainEntrySpecId,
            bundleId: domainEntrySpec.autoRun.bundleId,
          });
        }
      }
    }
    return {
      entries,
      autoRunInfos,
    };
  }

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

  private _getDomainId(path: string): string | undefined {
    for (const { domainId, sourceRoot } of this._domainSourceRootMap) {
      if (path.startsWith(sourceRoot)) {
        return domainId;
      }
    }
    return undefined;
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

    const {entries, autoRunInfos} = this._makeEntries();
    const buildExtras: BuildExtras = {
      entryFiles: new Set(),
      autoRunInfos,
    };
    for (const domain of Object.values(this._domains)) {
      for (const implicitEntry of domain.getImplicitEntries()) {
        buildExtras.entryFiles.add(implicitEntry);
      }
    }

    this._lastBuildExtras = buildExtras;
    return [
      await this._buildRecord.rebuild({
        entries: entries,
        uuidProvider: this._uuidProvider,
      }),
      buildExtras,
    ] as const;
  }

  private async _onBuildEnd(buildResult: BuildResult, extras: BuildExtras) {
    this._nBuildEnds++;

    const affectedFiles: string[] = [];
    for (const {entryId, bundleId} of extras.autoRunInfos) {
      const proxyFile = join(this._projectPath, 'assets/oms', `${bundleId}.ts`);
      const proxyFileContent = await this._renderProxyFile(bundleId);
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

  private async _renderProxyFile(bundleId: string) {
    const template = await fs.readFile(join(helpersDir, 'proxy.ts.ejs'), 'utf8');
    const source = Ejs.render(template, {
      bundleId,
    });
    return source;
  }

  private async _loadCentralizedUUIDs() {
    await this._uuidManager.loadCentralized(this._getCentralizedUUIDMappingPath());
    this._reportUUIDDuplications();
  }

  private async _saveCentralizedUUIDs() {
    await this._uuidManager.saveCentralized(this._getCentralizedUUIDMappingPath());
  }

  private _reportUUIDDuplications() {
    const duplications = this._uuidManager.getDuplications();
    for (const [uuid, modules] of duplications) {
      logger.error(`UUID ${uuid} is duplicated in modules: ${modules.join(', ')}`);
    }
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
      } else if (operation === 'delete') {
        entryChanged = (await this._removeWatchFile(file)) || entryChanged;
      } else if (operation === 'change') {
        await this._updateWatchFile(file);
      }
    }
    this._reportUUIDDuplications();
    return entryChanged;
  }

  private async _addWatchFile(path: string) {
    const domainId = this._getDomainId(path);
    if (!domainId) {
      return false;
    }
    const domain = this._domains[domainId];
    assert.ok(domain, `Domain ${domainId} not found`);
    const shouldRebuildBundles = await domain.addSourceFile(path);
    return shouldRebuildBundles;
  }

  private async _removeWatchFile(path: string) {
    const domainId = this._getDomainId(path);
    if (!domainId) {
      return false;
    }
    const domain = this._domains[domainId];
    assert.ok(domain, `Domain ${domainId} not found`);
    const shouldRebuildBundle = await domain.removeSourceFile(path);
    return shouldRebuildBundle;
  }

  private async _updateWatchFile(path: string) {
    const domainId = this._getDomainId(path);
    if (!domainId) {
      return false;
    }
    const domain = this._domains[domainId];
    if (domain) {
      await domain.updateSourceFile(path);
    }
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
} | {
  type: 'update-build-options';
  exec: () => Promise<void>;
};

interface BuildExtras {
  autoRunInfos: Array<{
    entryId: string;
    bundleId: string;
  }>;
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
  private _suppressRollupWarningCodes = [
    'CIRCULAR_DEPENDENCY',
    'THIS_IS_UNDEFINED',
    'UNUSED_EXTERNAL_IMPORT',
  ];
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

      rollupPluginJson({
        namedExports: false,
      }),

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
      onwarn: (warning, warn) => {
        if (warning.code && this._suppressRollupWarningCodes.includes(warning.code)) {
          return;
        }
        warn(warning);
      },
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
          allowDeclareFields: true,
        }],
      ],
    });
  }
}
