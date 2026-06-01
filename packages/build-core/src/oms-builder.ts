import { isAbsolute, join, relative, resolve } from 'node:path';
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
import { Domain, type DomainEntryQueryOptions } from './domain.js';
import { MergedTaskExecError, TaskQueue } from './task-queue.js';
import { setTimeout } from 'node:timers/promises';
import EventEmitter from 'node:events';
import { OmsProjectConfigWatcher } from './config-watcher.js';
import type { OmsProjectConfig } from './config.js';
import { BuildRecord, mergeBuildResults, type InternalBuildEntry, type InternalBuildResult } from './build-record.js';
import { OmsDomainConfigWatcher } from './domain-config-watcher.js';
import { makeOmsEntryFileName } from './utils/entry-id.js';

const mainDomainId = 'main';
const omsPackageRootEnvName = 'OMS_PACKAGE_ROOT';

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
  private _configWatcher: OmsProjectConfigWatcher | undefined;
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

    const rootOutDir = resolve(this._projectPath, 'temp', 'oms');

    const defaultProfile = {
      outDir: resolve(rootOutDir, 'out'),
      typingOutDir: resolve(rootOutDir, 'typing'),
    };
    await createProfileOutDirs(defaultProfile);
    await fs.outputJSON(join(defaultProfile.outDir, 'package.json'), {
      type: 'commonjs',
    }, {
      spaces: 2,
    });

    let headlessProfile: undefined | BuildProfile;
    if (config.headless.enabled) {
      headlessProfile = {
        outDir: resolve(rootOutDir, 'out-headless'),
        typingOutDir: resolve(rootOutDir, 'typing-headless'),
      };
      await createProfileOutDirs(headlessProfile);
      await fs.outputJSON(join(headlessProfile.outDir, 'package.json'), {
        type: 'module',
      }, {
        spaces: 2,
      });
      await fs.outputJSON(join(defaultProfile.outDir, 'package.json'), {
        type: 'module',
      }, {
        spaces: 2,
      });
    }

    assert(!this._watcher);
    const watcher = this._watcher = new OmsWatcher({
      projectPath: this._projectPath,
      defaultProfile,
      headlessProfile,
      ctx: this._ctx,
      buildOptions: this._buildOptions,
      config,
      uuidMapOutPath: join(rootOutDir, 'uuids.json'),
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
    return this._configWatcher = new OmsProjectConfigWatcher({
      projectPath: this._projectPath,
    });
  }
}

interface BuildProfile {
  outDir: string;
  typingOutDir: string;
}

async function createProfileOutDirs(profile: BuildProfile) {
  await ensureEmptyDirSafe(profile.outDir);
  await ensureEmptyDirSafe(profile.typingOutDir);
}

async function writeOmsTypingDeclarations(typingOutDir: string, domains: Record<string, Domain>) {
  const entries = Object.values(domains).flatMap((domain) => domain.generateTypingEntries());
  const declarationLines = [
    '// This file is generated by Oh My Script. Do not edit.',
  ];
  const omsRuntimeTypesPath = await resolveOmsRuntimeTypesPath();
  if (omsRuntimeTypesPath) {
    declarationLines.push(`/// <reference path=${JSON.stringify(makePathImportSpecifier(typingOutDir, omsRuntimeTypesPath))} />`);
  }
  declarationLines.push('');
  await fs.outputJson(join(typingOutDir, 'package.json'), {
    type: 'module',
    types: './index.d.ts',
  }, {
    spaces: 2,
  });
  for (const entry of entries) {
    declarationLines.push(
      `declare module ${JSON.stringify(entry.moduleId)} {`,
      `  export * from ${JSON.stringify(entry.packageName)};`,
      '}',
      '',
    );

    const packageDir = join(typingOutDir, 'node_modules', ...entry.packageName.split('/'));
    const source = await resolveTypingEntrySource(entry.source);
    const sourceSpecifier = makePathImportSpecifier(packageDir, source);
    await fs.outputJson(join(packageDir, 'package.json'), {
      type: 'module',
      types: './index.d.ts',
    }, {
      spaces: 2,
    });
    await fs.outputFile(join(packageDir, 'index.d.ts'), [
      `export * from ${JSON.stringify(sourceSpecifier)};`,
      '',
    ].join('\n'));
  }
  await fs.outputFile(join(typingOutDir, 'index.d.ts'), declarationLines.join('\n'));
}

async function resolveOmsRuntimeTypesPath() {
  const candidates = [
    process.env[omsPackageRootEnvName] ? join(process.env[omsPackageRootEnvName], 'types', 'oms.d.ts') : undefined,
    join(import.meta.dirname, '..', '..', '..', 'types', 'oms.d.ts'),
    join(import.meta.dirname, '..', '..', '..', '..', 'types', 'oms.d.ts'),
  ].filter((path): path is string => path !== undefined);
  for (const candidate of candidates) {
    if (await fs.pathExists(candidate)) {
      return await fs.realpath(candidate);
    }
  }
  logger.debug(`Failed to find OMS runtime types from ${omsPackageRootEnvName} or build-core location.`);
  return undefined;
}

async function resolveTypingEntrySource(source: string) {
  try {
    return await fs.realpath(source);
  } catch (err) {
    logger.debug(`Failed to resolve real path for OMS typing source ${source}: %o`, err);
    return source;
  }
}

function makePathImportSpecifier(fromDir: string, toFile: string) {
  let specifier = relative(fromDir, toFile);
  const absolute = isAbsolute(specifier);
  specifier = specifier.replace(/\\/g, '/');
  if (!absolute && !specifier.startsWith('.')) {
    specifier = `./${specifier}`;
  }
  return specifier;
}

async function ensureEmptyDirSafe(dir: string) {
  try {
    await fs.ensureDir(dir);
    await fs.emptyDir(dir);
  } catch (err) {
    logger.error(`Failed to clean directory ${dir}: ${err}`);
  }
}

interface BuildState {
  fullPassive: boolean;
}

class OmsWatcher extends EventEmitter<{
  'passive-build-end': [PassiveBuildEndInfo];
}> {
  constructor(options: {
    projectPath: string;
    defaultProfile: BuildProfile;
    headlessProfile: BuildProfile | undefined;
    ctx: ServerContext;
    buildOptions: BuildOptions;
    config: OmsProjectConfig;
    uuidMapOutPath: string;
  }) {
    super();
    const {
      projectPath,
      defaultProfile,
      headlessProfile,
      ctx,
      buildOptions,
      config,
    } = options;

    this._projectPath = projectPath;
    this._buildOptions = buildOptions;
    this._defaultProfile = defaultProfile;
    this._headlessProfile = headlessProfile;
    this._ctx = ctx;

    this._config = config;

    const treeShake = false;
    const buildRecord = new BuildRecord({
      title: `default-build`,
      outDir: defaultProfile.outDir,
      config,
      treeShake,
      headless: false,
      ccEnvParams: {
        debug: true,
      },
    });
    this._buildRecord = buildRecord;

    let headlessBuildRecord: undefined | BuildRecord;
    if (headlessProfile) {
      headlessBuildRecord = new BuildRecord({
        title: `headless-build`,
        outDir: headlessProfile.outDir,
        config,
        treeShake,
        headless: true,
        ccEnvParams: {
          platform: 'nodejs',
          debug: true,
          headless: true,
        },
      });
    }
    this._headlessBuildRecord = headlessBuildRecord;

    const uuidManager = new UUIDManager(this._projectPath, options.uuidMapOutPath);
    this._uuidManager = uuidManager;

    const uuidProvider = uuidManager.get.bind(uuidManager);
    this._uuidProvider = uuidProvider;

    const watcher = chokidar.watch([], {
      ignored: (path, stats) => {
        if (stats?.isFile()) {
          const lowercase = path.toLocaleLowerCase();
          if (lowercase.endsWith('.d.ts')) {
            return true;
          }
          if (/\.[mc]?[jt]sx?$/.test(lowercase)) {
            return false;
          }
          if (/.jsonc?$/.test(lowercase)) {
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
    await Promise.all(Object.values(this._domainConfigWatchers).map((watcher) => watcher.close()));
    this._domainConfigWatchers = {};
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

  async updateConfig(config: OmsProjectConfig) {
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
    return await this._queueBuild('build', false).catch((err) => {
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

    const configWatcher = new OmsProjectConfigWatcher({
      projectPath: this._projectPath,
      once: true,
    });
    const config = await configWatcher.ready();
    await configWatcher.close();

    const headless = opts.headless ?? false;

    const buildRecord = new BuildRecord({
      title: `prod-build`,
      outDir,
      sourceMaps: opts.sourceMaps,
      debug: opts.debug,
      ccEnvParams: {
        platform: opts.platform,
        mode: 'BUILD',
        debug: opts.debug,
      },
      config,
      headless,
      treeShake: true,
    });

    await this._taskQueue.queueTask({
      type: 'build-prod',

      exec: async () => {
        const { entries } = await this._makeEntries({
          regular: !headless,
          editor: false,
          headless: headless,
        });
        await buildRecord.rebuild({
          entries,
          uuidProvider: this._uuidProvider,
          domains: this._domains,
          projectRoot: this._projectPath,
          config: this._config,
          profileBuildConfig: undefined,
        });
      },
    });
  }

  private _projectPath: string;
  private _buildOptions: Readonly<BuildOptions>;
  private _config: OmsProjectConfig;

  private _defaultProfile: BuildProfile;
  private _headlessProfile: BuildProfile | undefined;
  private _ctx: ServerContext;
  private _uuidManager: UUIDManager;
  private _uuidProvider: UUIDProvider;
  private _buildRecord: BuildRecord;
  private _headlessBuildRecord: BuildRecord | undefined;
  private _fileWatcher: chokidar.FSWatcher;
  private _fileWatcherReadyPromise: PromiseWithResolvers<void> | undefined = promiseWithResolvers();
  private _passiveWatchedFiles = new Set<string>();
  private _nBuildEnds = 0;
  private _domains: Record<string, Domain> = {};
  private _domainSourceRootMap: Array<{
    domainId: string;
    sourceRoot: string;
  }> = [];
  private _domainConfigWatchers: Record<string, OmsDomainConfigWatcher> = {};

  private _fileQueue: Record<string, 'add' | 'delete' | 'change'> = {};
  private _lastBuildExtras: BuildExtras | undefined;
  private _taskQueue: TaskQueue<{
    'build': () => BuildResult;
    'rebuild': () => void;
    'inlineUUIDs': () => void;
    'build-prod': () => void;
    'update-build-options': () => void;
    'update-config': () => void;
    'update-domain-configs': () => void;
  }> = new TaskQueue();

  private async _updateDomains() {
    await Promise.all(Object.values(this._domainConfigWatchers).map((watcher) => watcher.close()));
    this._domainConfigWatchers = {};
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
    await writeOmsTypingDeclarations(this._defaultProfile.typingOutDir, this._domains);
    if (this._headlessProfile) {
      await writeOmsTypingDeclarations(this._headlessProfile.typingOutDir, this._domains);
    }
  }

  private async _addDomain(domainId: string, domainRoot: string, preferredDomainSourceRoot: string) {
    const domainConfigWatcher = new OmsDomainConfigWatcher({
      domainRoot,
      preferredSourceRoot: preferredDomainSourceRoot,
    });
    this._domainConfigWatchers[domainId] = domainConfigWatcher;
    const domainConfig = await domainConfigWatcher.ready();
    domainConfigWatcher.on('configUpdated', () => {
      this._queueDomainConfigUpdate(domainId).catch((err) => {
        logger.error(`Failed to update OMS domain config for ${domainId}: %o`, err);
      });
    });
    const domain = this._domains[domainId] = new Domain(
      domainId,
      domainRoot,
      domainConfig.partitions,
      domainConfig.exports,
      this._uuidManager,
      domainId === mainDomainId ? this._config.headless : undefined,
      domainConfig.exportPackageName,
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

  private async _queueDomainConfigUpdate(domainId: string) {
    await this._taskQueue.queueTask({
      type: 'update-domain-configs',
      exec: async () => {
        logger.debug(`Updating OMS domains because domain config changed: ${domainId}`);
        await this._updateDomains();
      },
    });
    this._queuePassiveBuild(`domain config updated: ${domainId}`);
  }

  private async _makeEntries(opts: DomainEntryQueryOptions) {
    const entries: Record<string, InternalBuildEntry> = {};
    const autoRunInfos: Array<{
      entryId: string;
      bundleId: string;
      isEditorEntry: boolean;
    }> = [];
    const exportEntries: Record<string, string> = {};
    for (const [domainId, domain] of Object.entries(this._domains)) {
      const domainEntrySpecs = domain.getEntrySpecs(opts);
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
        if (domainEntrySpec.exportId) {
          if (domainEntrySpec.exportId in exportEntries) {
            logger.warn(`Duplicate OMS export id: ${domainEntrySpec.exportId}`);
          } else {
            exportEntries[domainEntrySpec.exportId] = makeOmsEntryFileName(domainEntrySpecId);
          }
        }
      }
    }

    const metadataFileEntry = 'metadata';
    const metadataFileContent = await this._renderMetadataFile(autoRunInfos, exportEntries);
    entries[metadataFileEntry] = metadataFileContent;

    return {
      entries,
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

  private _queueBuild(reason: string, passive: boolean) {
    logger.verbose(`Will queue build. Reason: ${reason}`);
    return this._taskQueue.queueTask({
      type: 'build',
      mergeArgs: [passive],
      exec: async (ctx) => {
        ctx.acceptMerge = true;
        const state: BuildState = {
          fullPassive: passive,
        };
        const applyMergeArgs = (mergeArgs: readonly unknown[]) => {
          const [inputPassive] = mergeArgs;
          if (inputPassive === false) {
            state.fullPassive = false;
          }
        };
        for (const mergeArgs of ctx.initialMergeArgs) {
          applyMergeArgs(mergeArgs);
        }

        let interruptedByAbort = false;
        for (; ;) {
          const timerInterruptController = new AbortController();
          let interruptedByMerge = false;
          const onMerge = (mergeArgs: unknown[]) => {
            applyMergeArgs(mergeArgs);
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
        return await this._execBuild(state);
      },
    });
  }

  private _queuePassiveBuild(reason: string) {
    this._queueBuild(reason, true).catch((err) => {
      if (err instanceof MergedTaskExecError) {
        logger.debug(`Ignored merged task exec error: ${err}`);
      } else {
        logger.error(`Build failed: ${err}`);
      }
    });
  }

  private async _execBuild(state: BuildState): Promise<BuildResult> {
    const startState = {
      time: Date.now(),
    };
    await this._ctx.ipc.invoke('build-start', startState);

    const [buildResult, buildExtras] = await this._doExecBuild();

    await this._ctx.ipc.invoke('build-end', {
      time: Date.now(),
      startState,
    });

    const publicBuildResult = await this._onBuildEnd(buildResult, buildExtras);
    if (state.fullPassive) {
      this.emit('passive-build-end', { result: publicBuildResult });
    }
    return publicBuildResult;
  }

  private async _doExecBuild() {
    const entryChanged = await this._executeFileQueue();

    await this._uuidManager.emit();

    let defaultProfileBuildResult: InternalBuildResult;
    let headlessBuildResult: InternalBuildResult | undefined;
    if (this._lastBuildExtras && !entryChanged) {
      ([
        defaultProfileBuildResult,
        headlessBuildResult,
      ] = await promiseSequential([
        this._buildRecord.build(),
        this._headlessBuildRecord?.build(),
      ]));
    } else {
      this._lastBuildExtras = undefined;

      const buildExtras: BuildExtras = {
        entryFiles: new Set(),
      };

      const defaultProfileBuildPromise = (async () => {
        const { entries } = await this._makeEntries({
          regular: true,
          editor: true,
          headless: true,
        });
        for (const domain of Object.values(this._domains)) {
          for (const implicitEntry of domain.getImplicitEntries()) {
            buildExtras.entryFiles.add(implicitEntry);
          }
        }
        return this._buildRecord.rebuild({
          entries: entries,
          uuidProvider: this._uuidProvider,
          domains: this._domains,
          projectRoot: this._projectPath,
          config: this._config,
          profileBuildConfig: undefined,
        });
      })();

      const headlessBuildPromise = (async () => {
        if (!this._headlessBuildRecord) {
          return undefined;
        }
        const { entries } = await this._makeEntries({
          regular: false,
          editor: false,
          headless: true,
        });
        for (const domain of Object.values(this._domains)) {
          for (const implicitEntry of domain.getImplicitEntries()) {
            buildExtras.entryFiles.add(implicitEntry);
          }
        }
        return this._headlessBuildRecord.rebuild({
          entries: entries,
          uuidProvider: this._uuidProvider,
          domains: this._domains,
          projectRoot: this._projectPath,
          config: this._config,
          profileBuildConfig: this._config.headless.build,
        });
      })();

      ([
        defaultProfileBuildResult,
        headlessBuildResult,
      ] = await promiseSequential([
        defaultProfileBuildPromise,
        headlessBuildPromise,
      ]));

      this._lastBuildExtras = buildExtras;
    }

    const mergedBuildResult = headlessBuildResult ? mergeBuildResults(defaultProfileBuildResult, headlessBuildResult) : defaultProfileBuildResult;
    return [mergedBuildResult, this._lastBuildExtras] as const;
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
      let existingContent = '';
      try {
        existingContent = await fs.readFile(mainFile, 'utf8');
      } catch (err) {
        void err;
      }
      if (existingContent !== mainFileContent) {
        await fs.outputFile(mainFile, mainFileContent, 'utf8');
      }
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

  private async _renderMetadataFile(autoRunInfos: AutoRunInfos, exportEntries: Record<string, string>) {
    const template = await fs.readFile(join(helpersDir, 'meta.ts.ejs'), 'utf8');
    const source = Ejs.render(template, {
      entries: autoRunInfos.map(({ bundleId, isEditorEntry }) => {
        return {
          bundleId,
          isEditorEntry,
        };
      }),
      exportEntries,
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

async function promiseSequential<T extends readonly unknown[] | []>(promises: T): Promise<{ -readonly [P in keyof T]: Awaited<T[P]>; }> {
  type ResultType = { -readonly [P in keyof T]: Awaited<T[P]>; };
  const result: ResultType = new Array(promises.length) as ResultType;
  for (let i = 0; i < promises.length; i++) {
    result[i] = await promises[i];
  }
  return result;
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
  entryFiles: Set<string>;
}

type AutoRunInfos = Array<{
  entryId: string;
  bundleId: string;
  isEditorEntry: boolean;
}>;

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
