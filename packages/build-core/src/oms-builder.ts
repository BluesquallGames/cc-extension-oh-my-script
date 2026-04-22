import { join, resolve } from 'node:path';
import fs from 'fs-extra';
import { logger } from './logger.js';
import { ServerContext } from './server-context.js';
import * as chokidar from 'chokidar';
import { type UUIDProvider } from './features/babel-plugin-cc-component.js';
import assert from 'node:assert';
import { UUIDManager, writeInlineUUID } from './uuid-manager.js';
import type { BuildOptions, BuildResult, InvocationParams, PassiveBuildEndInfo } from './protocol.js';
import { promiseWithResolvers, type PromiseWithResolvers } from './utils/promise-with-resolvers.js';
import Ejs from 'ejs';
import { helpersDir } from './helpers-dir.js';
import { Domain, readDomainExports, readDomainPackageJson } from './domain.js';
import { MergedTaskExecError, TaskQueue } from './task-queue.js';
import { setTimeout } from 'node:timers/promises';
import EventEmitter from 'node:events';
import { OmsConfigWatcher } from './config-watcher.js';
import type { OmsConfig } from './config.js';
import { BuildRecord, type InternalBuildResult } from './build-record.js';

const mainDomainId = 'main';

export class OmsBuilder extends EventEmitter<{
  'passive-build-end': [PassiveBuildEndInfo];
}> {
  constructor(private _ctx: ServerContext, {
    project,
  }: {
    project: string;
  }) {
    super();
    this._projectPath = project;
  }

  async rebuild(opts: BuildOptions): Promise<BuildResult> {
    return await this._taskQueue.queueTask({
      type: 'rebuild',
      exec: async () => {
        this._buildOptions = opts;
        return await this._rebuild();
      },
    });
  }

  async updateBuildOptions(opts: BuildOptions) {
    return await this._taskQueue.queueTask({
      type: 'updateBuildOptions',
      exec: async () => {
        this._buildOptions = opts;
        if (this._watcher) {
          await this._watcher.updateBuildOptions(opts);
        }
      },
    });
  }

  async inlineUUIDs() {
    return await this._taskQueue.queueTask({
      type: 'inlineUUIDs',
      exec: async () => {
        await this._watcher?.inlineUUIDs();
      },
    });
  }

  async buildProd(opts: InvocationParams<'build-prod'>) {
    return await this._taskQueue.queueTask({
      type: 'buildProd',
      exec: async () => {
        await this._watcher?.buildProd(opts);
      },
    });
  }

  private _projectPath: string;
  private _configWatcher: OmsConfigWatcher | undefined;
  private _watcher: OmsWatcher | undefined;
  private _buildOptions: BuildOptions = {
    extensionBuildOptions: [],
  };

  private _taskQueue = new TaskQueue<{
    rebuild: () => BuildResult;
    updateBuildOptions: () => void;
    inlineUUIDs: () => void;
    buildProd: () => void;
  }>();

  private async _clean() {
    const configWatcher = this._configWatcher;
    if (configWatcher) {
      this._configWatcher = undefined;
      await configWatcher.close();
    }
    const watcher = this._watcher;
    if (watcher) {
      this._watcher = undefined;
      await watcher.close();
    }
  }

  private async _rebuild() {
    await this._clean();

    const configWatcher = await this._initializeConfigWatcher();

    const config = await configWatcher.ready();

    const outDir = resolve(this._projectPath, 'temp', 'oms', 'out');
    try {
      await fs.ensureDir(outDir);
      await fs.emptyDir(outDir);
    } catch (err) {
      logger.error(`Failed to clean output directory ${outDir}: ${err}`);
    }

    await fs.outputJSON(join(outDir, 'package.json'), {
      type: 'commonjs',
    }, {
      spaces: 2,
    });

    const typingOutDir = resolve(this._projectPath, 'temp', 'oms', 'typing');
    await fs.ensureDir(typingOutDir);
    await fs.emptyDir(typingOutDir);

    assert(!this._watcher);
    const watcher = this._watcher = new OmsWatcher({
      projectPath: this._projectPath,
      outDir,
      typingOutDir,
      ctx: this._ctx,
      buildOptions: this._buildOptions,
      config,
    });
    this._watcher.on('passive-build-end', (buildResult) => {
      this.emit('passive-build-end', buildResult);
    });

    configWatcher.on('configUpdated', (config) => {
      watcher.updateConfig(config).catch((err) => {
        logger.error(err);
      });
    });

    await this._watcher.start();
    return await this._watcher.build();
  }

  private async _initializeConfigWatcher() {
    assert.ok(!this._configWatcher);
    return this._configWatcher = new OmsConfigWatcher({
      projectPath: this._projectPath,
    });
  }
}

class OmsWatcher extends EventEmitter<{
  'passive-build-end': [PassiveBuildEndInfo];
}> {
  constructor(options: {
    projectPath: string;
    outDir: string;
    typingOutDir: string;
    ctx: ServerContext;
    buildOptions: BuildOptions;
    config: OmsConfig;
  }) {
    super();
    const {
      projectPath,
      outDir,
      typingOutDir,
      ctx,
      buildOptions,
      config,
    } = options;

    this._projectPath = projectPath;
    this._buildOptions = buildOptions;
    this._outDir = outDir;
    this._typingOutDir = typingOutDir;
    this._ctx = ctx;

    this._config = config;

    const buildRecord = new BuildRecord({
      outDir,
      config,
    });
    this._buildRecord = buildRecord;

    const uuidManager = new UUIDManager(this._projectPath);
    this._uuidManager = uuidManager;

    const uuidProvider = uuidManager.get.bind(uuidManager);
    this._uuidProvider = uuidProvider;

    const watcher = chokidar.watch([], {
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
        this._fileWatcherReadyPromise?.resolve();
        this._fileWatcherReadyPromise = undefined;
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
        this._queuePassiveBuild('file added');
      })
      .on('change', (path) => {
        switch (this._fileQueue[path]) {
        case 'add':
        case 'delete':
          return;
        }
        this._fileQueue[path] = 'change';
        this._queuePassiveBuild('file changed');
      })
      .on('unlink', (path) => {
        this._fileQueue[path] = 'delete';
        this._queuePassiveBuild('file deleted');
      })
      .on('addDir', (path) => {
        void path;
      })
      .on('unlinkDir', (path) => {
        void path;
      })
    ;
  }

  async start() {
    await this._updateDomains();
    await this._loadCentralizedUUIDs();
  }

  async close() {
    await this._fileWatcher.close();
    await this._taskQueue.abort();
  }

  async updateBuildOptions(options: BuildOptions) {
    await this._taskQueue.queueTask({
      type: 'update-build-options',
      exec: async () => {
        this._buildOptions = options;
        await this._updateDomains();
      },
    });
    this._queuePassiveBuild('build options updated');
  }

  async updateConfig(config: OmsConfig) {
    await this._taskQueue.queueTask({
      type: 'update-config',
      exec: async () => {
        this._config = config;
        await this._updateDomains();
      },
    });
    this._queuePassiveBuild('config updated');
  }

  async inlineUUIDs() {
    await this._taskQueue.queueTask({
      type: 'inlineUUIDs',
      exec: async () => {
        await this._execInlineUUIDs();
      },
    });
  }

  async build() {
    return await this._queueBuild('build').catch((err) => {
      if (err instanceof MergedTaskExecError) {
        throw err.cause;
      } else {
        throw err;
      }
    });
  }

  async buildProd(opts: InvocationParams<'build-prod'>) {
    logger.debug(`Performing production build. Options: %o`, opts);

    const outDir = join(opts.buildDir, 'oms');

    const configWatcher = new OmsConfigWatcher({
      projectPath: this._projectPath,
      once: true,
    });
    const config = await configWatcher.ready();
    await configWatcher.close();

    const buildRecord = new BuildRecord({
      outDir,
      sourceMaps: opts.sourceMaps,
      debug: opts.debug,
      ccEnvParams: {
        platform: opts.platform,
        mode: 'BUILD',
        debug: opts.debug,
      },
      config,
    });

    await this._taskQueue.queueTask({
      type: 'build-prod',

      exec: async () => {
        const { entries, autoRunInfos } = await this._makeEntries(false);
        await buildRecord.rebuild({
          entries,
          uuidProvider: this._uuidProvider,
          domains: this._domains,
          config: this._config,
        });
      },
    });
  }

  private _projectPath: string;
  private _buildOptions: Readonly<BuildOptions>;
  private _config: OmsConfig;

  private _outDir: string;
  private _typingOutDir: string;
  private _ctx: ServerContext;
  private _uuidManager: UUIDManager;
  private _uuidProvider: UUIDProvider;
  private _buildRecord: BuildRecord;
  private _fileWatcher: chokidar.FSWatcher;
  private _fileWatcherReadyPromise: PromiseWithResolvers<void> | undefined = promiseWithResolvers();
  private _passiveWatchedFiles = new Set<string>();
  private _nBuildEnds = 0;
  private _domains: Record<string, Domain> = {};
  private _domainSourceRootMap: Array<{
    domainId: string;
    sourceRoot: string;
  }> = [];

  private _fileQueue: Record<string, 'add' | 'delete' | 'change'> = {};
  private _lastBuildExtras: BuildExtras | undefined;
  private _taskQueue: TaskQueue<{
    'build': () => BuildResult;
    'rebuild': () => void;
    'inlineUUIDs': () => void;
    'build-prod': () => void;
    'update-build-options': () => void;
    'update-config': () => void;
  }> = new TaskQueue();

  private async _updateDomains() {
    this._domains = {};
    this._domainSourceRootMap.length = 0;
    const domainPromises: Promise<void>[] = [];
    const mainDomainRoot = join(this._projectPath);
    domainPromises.push(this._addDomain(
      mainDomainId, mainDomainRoot, 'src',
    ));
    for (const { name: extensionName, path: extensionPath } of this._buildOptions.extensionBuildOptions) {
      const extensionDomainRoot = join(extensionPath);
      domainPromises.push(this._addDomain(
        extensionName, extensionDomainRoot, 'oms/src',
      ));
    }
    await Promise.all(domainPromises);
    const pathMappings: Record<string, string[]> = {};
    for (const [domainId, domain] of Object.entries(this._domains)) {
      const domainPathMappings = domain.generatePathMappings();
      Object.assign(pathMappings, domainPathMappings);
    }
    await fs.outputJson(join(this._typingOutDir, 'tsconfig.json'), {
      compilerOptions: {
        paths: pathMappings,
      },
    }, {
      spaces: 2,
    });
  }

  private async _addDomain(domainId: string, domainRoot: string, preferredDomainSourceRoot: string) {
    const domainPackageJson = await readDomainPackageJson(domainRoot);
    const partitions = domainPackageJson?.oms?.partitions ?? [
      { rootDir: preferredDomainSourceRoot },
    ];
    const domainExports = await readDomainExports(domainRoot, partitions, domainPackageJson);
    const domain = this._domains[domainId] = new Domain(
      domainId,
      domainRoot,
      partitions,
      domainExports,
      this._uuidManager,
    );
    const sourceRoots = domain.sourceRoots;
    for (const sourceRoot of sourceRoots) {
      this._domainSourceRootMap.push({
        domainId,
        sourceRoot,
      });
    }
    this._domainSourceRootMap.sort((a, b) => b.sourceRoot.length - a.sourceRoot.length);
    for (const sourceRoot of sourceRoots) {
      this._fileWatcher.add(sourceRoot);
    }
  }

  private async _makeEntries(includeEditorBundle: boolean) {
    const entries: Record<string, string> = {};
    const autoRunInfos: Array<{
      entryId: string;
      bundleId: string;
      isEditorEntry: boolean;
    }> = [];
    for (const [domainId, domain] of Object.entries(this._domains)) {
      const domainEntrySpecs = domain.getEntrySpecs(includeEditorBundle);
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
            isEditorEntry: domainEntrySpec.autoRun.isEditorEntry,
          });
        }
      }
    }

    const metadataFileEntry = 'metadata';
    const metadataFileContent = await this._renderMetadataFile(autoRunInfos);
    entries[metadataFileEntry] = metadataFileContent;

    return {
      entries,
      autoRunInfos,
    };
  }

  private _getDomainId(path: string): string | undefined {
    for (const { domainId, sourceRoot } of this._domainSourceRootMap) {
      if (path.startsWith(sourceRoot)) {
        return domainId;
      }
    }
    return undefined;
  }

  private _queueBuild(reason: string) {
    logger.verbose(`Will queue build. Reason: ${reason}`);
    return this._taskQueue.queueTask({
      type: 'build',
      exec: async (ctx) => {
        ctx.acceptMerge = true;

        let interruptedByAbort = false;
        for (; ;) {
          const timerInterruptController = new AbortController();
          let interruptedByMerge = false;
          const onMerge = () => {
            interruptedByMerge = true;
            timerInterruptController.abort();
          };
          ctx.once('merge', onMerge);
          const onAbort = () => {
            interruptedByAbort = true;
            timerInterruptController.abort();
          };
          ctx.once('abort', onAbort);
          try {
            logger.verbose(`Waiting for further merge signal...`);
            await setTimeout(100, undefined, {
              signal: timerInterruptController.signal,
            });
          } catch (err) {
            if (typeof err === 'object' && err !== null && 'name' in err && err.name === 'AbortError') {
              if (interruptedByMerge) {
                logger.verbose(`Build merged.`);
                continue;
              }
            }
          } finally {
            ctx.off('merge', onMerge);
            ctx.off('abort', onAbort);
          }
          break;
        }

        if (interruptedByAbort) {
          throw new Error('Build aborted by user');
        }

        logger.verbose(`Build started.`);
        ctx.acceptMerge = false;

        await this._fileWatcherReadyPromise?.promise;
        return await this._execBuild();
      },
    });
  }

  private _queuePassiveBuild(reason: string) {
    this._queueBuild(reason).then((buildResult) => {
      this.emit('passive-build-end', { result: buildResult });
    }).catch((err) => {
      if (err instanceof MergedTaskExecError) {
        logger.debug(`Ignored merged task exec error: ${err}`);
      } else {
        logger.error(`Build failed: ${err}`);
      }
    });
  }

  private async _execBuild(): Promise<BuildResult> {
    const startState = {
      time: Date.now(),
    };
    await this._ctx.ipc.invoke('build-start', startState);

    const [buildResult, buildExtras] = await this._doExecBuild();

    await this._ctx.ipc.invoke('build-end', {
      time: Date.now(),
      startState,
    });

    return await this._onBuildEnd(buildResult, buildExtras);
  }

  private async _doExecBuild() {
    const entryChanged = await this._executeFileQueue();

    if (this._lastBuildExtras) {
      if (!entryChanged) {
        return [await this._buildRecord.build(), this._lastBuildExtras] as const;
      }
    }

    this._lastBuildExtras = undefined;

    const { entries, autoRunInfos } = await this._makeEntries(true);
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
        domains: this._domains,
        config: this._config,
      }),
      buildExtras,
    ] as const;
  }

  private async _onBuildEnd(buildResult: InternalBuildResult, extras: BuildExtras): Promise<BuildResult> {
    this._nBuildEnds++;

    if (!buildResult.ok) {
      return {
        ok: false,
        error: buildResult.error,
      };
    }

    const affectedFiles: string[] = [];
    {
      const mainFile = join(this._projectPath, 'assets/oms.ts');
      const mainFileContent = await this._renderMainFile();
      await fs.outputFile(mainFile, mainFileContent, 'utf8');
      affectedFiles.push(mainFile);
    }

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

    return {
      ok: true,
      affectedFiles,
    };
  }

  private async _renderMetadataFile(autoRunInfos: BuildExtras['autoRunInfos']) {
    const template = await fs.readFile(join(helpersDir, 'meta.ts.ejs'), 'utf8');
    const source = Ejs.render(template, {
      entries: autoRunInfos.map(({ bundleId, isEditorEntry }) => {
        return {
          bundleId,
          isEditorEntry,
        };
      }),
    });
    return source;
  }

  private async _renderMainFile() {
    const template = await fs.readFile(join(helpersDir, 'main.ts.ejs'), 'utf8');
    const source = Ejs.render(template, {
      // nope
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
      await this._uuidManager.update(file, uuid);
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

interface BuildExtras {
  autoRunInfos: Array<{
    entryId: string;
    bundleId: string;
    isEditorEntry: boolean;
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
