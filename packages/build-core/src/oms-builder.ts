import process from 'node:process';
import { basename, isAbsolute, join, normalize, relative, resolve } from 'node:path';
import type { Dirent, Stats } from 'node:fs';
import fs from 'fs-extra';
import { logger } from './logger.js';
import { ServerContext } from './server-context.js';
import * as chokidar from 'chokidar';
import { type UUIDProvider } from './features/babel-plugin-cc-component.js';
import assert from 'node:assert';
import { UUIDManager, writeInlineUUID } from './uuid-manager.js';
import {
  allBuildProfileIds,
  BuildProfileId,
  type BuildOptions,
  type BuildProfileResult,
  type BuildProfileResults,
  type InvocationParams,
  type PassiveBuildEndInfo,
  type PassiveProfileBuildEndInfo,
  type RebuildOptions,
} from './protocol.js';
import { promiseWithResolvers, type PromiseWithResolvers } from './utils/promise-with-resolvers.js';
import Ejs from 'ejs';
import { helpersDir } from './helpers-dir.js';
import {
  Domain,
  readOmsDomainConfig,
  type DomainProfile,
  type ProfileBuildOptions,
} from './domain.js';
import { MergedTaskExecError, TaskQueue } from './task-queue.js';
import { setTimeout } from 'node:timers/promises';
import EventEmitter from 'node:events';
import { OmsProjectConfigWatcher } from './config-watcher.js';
import type { OmsConfigContext, OmsProjectConfig, ProfileConfig } from './config.js';
import { BuildRecord, type InternalBuildEntry, type InternalBuildResult } from './build-record.js';
import { OmsDomainConfigWatcher } from './domain-config-watcher.js';
import { makeOmsEntryFileName } from './utils/entry-id.js';
import { isPathInside } from './utils/path.js';
import { isDeepStrictEqual } from 'node:util';

const mainDomainId = 'main';
const omsPackageRootEnvName = 'OMS_PACKAGE_ROOT';
const developmentConfigContext: OmsConfigContext = { mode: 'development' };
const productionConfigContext: OmsConfigContext = { mode: 'production' };

function makeDefaultDomainProfile(profileConfig: ProfileConfig | undefined): DomainProfile {
  return {
    id: BuildProfileId.default,
    sourceMatcher: makeProfileSourceMatcher(profileConfig),
    bundle: {
      idSuffix: '',
      indexPreStem: 'index-pre',
      indexPostStem: 'index',
    },
  };
}

function makeHeadlessDomainProfile(profileConfig: ProfileConfig | undefined): DomainProfile {
  return {
    id: BuildProfileId.headless,
    sourceMatcher: makeProfileSourceMatcher(profileConfig),
    bundle: {
      idSuffix: '.headless',
      indexPreStem: 'index-pre.headless',
      indexPostStem: 'index.headless',
    },
  };
}

function makeProfileSourceMatcher(profileConfig: ProfileConfig | undefined) {
  return (relativePath: string) => {
    return (!profileConfig?.include || profileConfig.include(relativePath))
      && (!profileConfig?.exclude?.(relativePath));
  };
}

export class OmsBuilder extends EventEmitter<{
  'passive-build-end': [PassiveBuildEndInfo];
  'passive-profile-build-end': [PassiveProfileBuildEndInfo];
}> {
  constructor(private _ctx: ServerContext, {
    project,
  }: {
    project: string;
  }) {
    super();
    this._projectPath = project;
  }

  async rebuild(opts: RebuildOptions = {}): Promise<BuildProfileResults> {
    const profiles = normalizeBuildProfiles(opts.profiles);
    if (this._startPromise) {
      const startedWatcher = await this._startPromise;
      return await startedWatcher.initialBuild.waitFor(profiles);
    }
    if (this._watcherReady) {
      const watcher = this._watcher;
      assert.ok(watcher);
      return await watcher.build({ profiles });
    }
    const startedWatcher = await this._ensureStarted();
    return await startedWatcher.initialBuild.waitFor(profiles);
  }

  async cleanRebuild(opts: RebuildOptions = {}): Promise<BuildProfileResults> {
    const profiles = normalizeBuildProfiles(opts.profiles);
    const startedWatcher = promiseWithResolvers<StartedWatcher>();
    const cleanBuild = this._taskQueue.queueTask({
      type: 'cleanRebuild',
      exec: async () => {
        try {
          const watcher = await this._replaceWatcher();
          startedWatcher.resolve(watcher);
          return await watcher.initialBuild.waitFor(profiles);
        } catch (err) {
          startedWatcher.reject(err);
          throw err;
        }
      },
    });
    const startPromise = Promise.race([
      startedWatcher.promise,
      cleanBuild.then(() => startedWatcher.promise),
    ]);
    this._startPromise = startPromise;
    try {
      const [, profileResults] = await Promise.all([startPromise, cleanBuild]);
      return profileResults;
    } finally {
      if (this._startPromise === startPromise) {
        this._startPromise = undefined;
      }
    }
  }

  async updateBuildOptions(opts: BuildOptions) {
    return await this._taskQueue.queueTask({
      type: 'updateBuildOptions',
      exec: async () => {
        if (isDeepStrictEqual(this._buildOptions, opts)) {
          return;
        }
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

  async close(options: CloseOptions = {}) {
    const abortPromise = this._taskQueue.abort();
    if (options.waitForTasks ?? true) {
      await abortPromise;
    } else {
      abortPromise.catch((err) => {
        logger.error(`Failed to abort OMS builder task queue: %o`, err);
      });
    }
    await this._clean(options);
    this.removeAllListeners();
  }

  private _projectPath: string;
  private _configWatcher: OmsProjectConfigWatcher | undefined;
  private _watcher: OmsWatcher | undefined;
  private _startPromise: Promise<StartedWatcher> | undefined;
  private _watcherReady = false;
  private _buildOptions: BuildOptions = {
    extensionBuildOptions: [],
  };

  private _taskQueue = new TaskQueue<{
    start: () => StartedWatcher;
    cleanRebuild: () => BuildProfileResults;
    updateBuildOptions: () => void;
    inlineUUIDs: () => void;
    buildProd: () => void;
  }>();

  private async _clean(options: CloseOptions = {}) {
    this._watcherReady = false;
    this._startPromise = undefined;
    await this._disposeWatcher(options);
  }

  private async _disposeWatcher(options: CloseOptions = {}) {
    const configWatcher = this._configWatcher;
    if (configWatcher) {
      this._configWatcher = undefined;
      await configWatcher.close();
    }
    const watcher = this._watcher;
    if (watcher) {
      this._watcher = undefined;
      await watcher.close(options);
    }
  }

  private async _replaceWatcher() {
    this._watcherReady = false;
    await this._disposeWatcher();
    return await this._startWatcherWithRollback();
  }

  private async _ensureStarted(): Promise<StartedWatcher> {
    assert.ok(!this._watcherReady, 'OMS watcher is already started');
    if (this._startPromise) {
      return await this._startPromise;
    }
    const startPromise = this._taskQueue.queueTask({
      type: 'start',
      exec: async () => await this._startWatcherWithRollback(),
    });
    this._startPromise = startPromise;
    try {
      return await startPromise;
    } finally {
      if (this._startPromise === startPromise) {
        this._startPromise = undefined;
      }
    }
  }

  private async _startWatcherWithRollback() {
    try {
      return await this._startWatcher();
    } catch (err) {
      this._watcherReady = false;
      await this._disposeWatcher();
      throw err;
    }
  }

  private async _startWatcher(): Promise<StartedWatcher> {
    const configWatcher = this._initializeConfigWatcher();

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

    const headlessProfile: BuildProfile = {
      outDir: resolve(rootOutDir, 'out-headless'),
      typingOutDir: resolve(rootOutDir, 'typing-headless'),
    };
    if (config.profiles.headless) {
      await initializeHeadlessProfile(headlessProfile);
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
    this._watcher.on('passive-profile-build-end', (buildResult) => {
      this.emit('passive-profile-build-end', buildResult);
    });

    configWatcher.on('configUpdated', (config) => {
      watcher.updateConfig(config).catch((err) => {
        if (err instanceof OmsWatcherClosedError) {
          return;
        }
        logger.error(err);
      });
    });

    const initialBuild = await watcher.start();
    this._watcherReady = true;
    return {
      watcher,
      initialBuild,
    };
  }

  private _initializeConfigWatcher() {
    assert.ok(!this._configWatcher);
    return this._configWatcher = new OmsProjectConfigWatcher({
      projectPath: this._projectPath,
      context: developmentConfigContext,
    });
  }
}

interface StartedWatcher {
  watcher: OmsWatcher;
  initialBuild: ProfileBuildBatch;
}

interface BuildProfile {
  outDir: string;
  typingOutDir: string;
}

interface CloseOptions {
  waitForTasks?: boolean;
}

async function createProfileOutDirs(profile: BuildProfile) {
  await ensureEmptyDirSafe(profile.outDir);
  await ensureEmptyDirSafe(profile.typingOutDir);
}

async function initializeHeadlessProfile(profile: BuildProfile) {
  await createProfileOutDirs(profile);
  await fs.outputJSON(join(profile.outDir, 'package.json'), {
    type: 'module',
  }, {
    spaces: 2,
  });
}

async function writeOmsTypingDeclarations(typingOutDir: string, domains: Record<string, Domain>) {
  const entries = Object.values(domains).flatMap((domain) => domain.generateTypingEntries());
  const declarationLines = [
    '// This file is generated by Oh My Script. Do not edit.',
  ];
  const omsRuntimeTypesPath = await resolveOmsRuntimeTypesPath();
  if (omsRuntimeTypesPath) {
    declarationLines.push(`/// <reference path=${JSON.stringify(makePathImportSpecifier(
      typingOutDir, omsRuntimeTypesPath))} />`);
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
    process.env[omsPackageRootEnvName]
      ? join(process.env[omsPackageRootEnvName],
        'types',
        'oms.d.ts')
      : undefined,
    join(import.meta.dirname, '..', '..', '..', 'types', 'oms.d.ts'),
    join(import.meta.dirname, '..', '..', '..', '..', 'types', 'oms.d.ts'),
  ].filter((path): path is string => path !== undefined);
  for (const candidate of candidates) {
    if (await fs.pathExists(candidate)) {
      return await fs.realpath(candidate);
    }
  }
  logger.debug(
    `Failed to find OMS runtime types from ${omsPackageRootEnvName} or build-core location.`);
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
    logger.error(`Failed to clean directory ${dir}: %o`, err);
  }
}

interface BuildState {
  hasPassiveRequest: boolean;
  activeProfiles: Set<BuildProfileId>;
  requests: ProfileBuildRequest[];
  profiles: Set<BuildProfileId>;
}

interface WatchBuildOptions {
  profiles?: BuildProfileId[];
}

interface ProfileBuildRequest {
  profile: BuildProfileId;
  passive: boolean;
  result: PromiseWithResolvers<BuildProfileResult>;
  settled: boolean;
}

interface ProfileBuildBatch {
  waitFor(profiles: BuildProfileId[]): Promise<BuildProfileResults>;
}

interface ActiveBuildRevision {
  state: BuildState;
  profileResults: ReadonlyMap<BuildProfileId, Promise<BuildProfileResult>>;
  settledProfiles: Set<BuildProfileId>;
}

enum FileWatcherPhase {
  Starting = 'starting',
  Ready = 'ready',
  Closed = 'closed',
}

class OmsWatcherClosedError extends Error {
  constructor() {
    super('OMS watcher closed');
    this.name = 'OmsWatcherClosedError';
  }
}

class OmsWatcher extends EventEmitter<{
  'passive-build-end': [PassiveBuildEndInfo];
  'passive-profile-build-end': [PassiveProfileBuildEndInfo];
}> {
  constructor(options: {
    projectPath: string;
    defaultProfile: BuildProfile;
    headlessProfile: BuildProfile;
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
      projectRoot: projectPath,
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

    this._headlessBuildRecord = config.profiles.headless
      ? this._createHeadlessBuildRecord(config)
      : undefined;

    const uuidManager = new UUIDManager(this._projectPath, options.uuidMapOutPath);
    this._uuidManager = uuidManager;

    const uuidProvider = uuidManager.getByKey.bind(uuidManager);
    this._uuidProvider = uuidProvider;
  }

  async start() {
    await this._updateDomains();
    await this._loadCentralizedUUIDs();
    this._fileQueueConsumerScheduled = true;
    this._fileQueueConsumerProfiles = new Set(allBuildProfileIds);
    await this._restartFileWatcher();
    await this._collectInitialSourceFiles();
    const initialBuild = this._requestProfiles('initial full build', false, allBuildProfileIds);
    initialBuild.waitFor(allBuildProfileIds).then((profileResults) => {
      for (const [profile, result] of Object.entries(profileResults)) {
        if (!result.ok) {
          logger.error(`Initial ${profile} profile build failed: ${result.error.message}`);
        }
      }
    }).catch((err) => {
      if (err instanceof OmsWatcherClosedError) {
        return;
      }
      logger.error(`Initial full build failed: %o`, err);
    });
    return initialBuild;
  }

  async close(options: CloseOptions = {}) {
    this._closing = true;
    this._rejectProfileBuildRequests(new OmsWatcherClosedError());
    const abortPromise = this._taskQueue.abort();
    if (options.waitForTasks ?? true) {
      await abortPromise;
    } else {
      abortPromise.catch((err) => {
        logger.error(`Failed to abort OMS watcher task queue: %o`, err);
      });
    }
    await this._closeFileWatcher();
    this._profileBuildExtras = {};
    await Promise.all(Object.values(this._domainConfigWatchers).map((watcher) => watcher.close()));
    this._domainConfigWatchers = {};
  }

  async updateBuildOptions(options: BuildOptions) {
    this._assertOpen();
    await this._taskQueue.queueTask({
      type: 'update-build-options',
      exec: async () => {
        this._buildOptions = options;
        await this._reloadDomainsAndFileWatcher();
      },
    });
    this._queuePassiveBuild('build options updated');
  }

  async updateConfig(config: OmsProjectConfig) {
    this._assertOpen();
    await this._taskQueue.queueTask({
      type: 'update-config',
      exec: async () => {
        this._config = config;
        await this._syncHeadlessProfile(config);
        await this._reloadDomainsAndFileWatcher();
      },
    });
    this._queuePassiveBuild('config updated');
  }

  async inlineUUIDs() {
    this._assertOpen();
    await this._taskQueue.queueTask({
      type: 'inlineUUIDs',
      exec: async () => {
        await this._execInlineUUIDs();
      },
    });
  }

  async build(options: WatchBuildOptions = {}) {
    const profiles = normalizeBuildProfiles(options.profiles);
    return await this._requestProfiles('build', false, profiles).waitFor(profiles);
  }

  async buildProd(opts: InvocationParams<'build-prod'>) {
    this._assertOpen();
    logger.debug(`Performing production build. Options: %o`, opts);

    const outDir = join(opts.buildDir, 'oms');

    const configWatcher = new OmsProjectConfigWatcher({
      projectPath: this._projectPath,
      context: productionConfigContext,
      once: true,
    });
    const config = await (async () => {
      try {
        return await configWatcher.ready();
      } finally {
        await configWatcher.close();
      }
    })();
    this._assertOpen();

    const headless = opts.headless ?? false;

    const buildRecord = new BuildRecord({
      projectRoot: this._projectPath,
      title: `prod-build`,
      outDir,
      sourceMaps: opts.sourceMaps,
      minify: !opts.debug,
      ccEnvParams: {
        platform: opts.platform,
        mode: 'build',
        debug: opts.debug,
      },
      config,
      headless,
      treeShake: true,
      mode: 'production',
    });

    await this._taskQueue.queueTask({
      type: 'build-prod',

      exec: async () => {
        const productionDomains = await this._createProductionDomains(config);
        const { entries } = await this._makeEntries(
          headless ? BuildProfileId.headless : BuildProfileId.default,
          headless ? { dynamicExports: false } : undefined,
          productionDomains,
        );
        await fs.emptyDir(outDir);
        const buildResult = await buildRecord.rebuild({
          entries,
          uuidProvider: this._uuidProvider,
          domains: productionDomains,
          config,
          profileBuildConfig: headless ? config.profiles.headless?.build : undefined,
        });
        if (!buildResult.ok) {
          const error = new Error(buildResult.error.message);
          error.stack = buildResult.error.stack;
          throw error;
        }
      },
    });
  }

  private _projectPath: string;
  private _buildOptions: Readonly<BuildOptions>;
  private _config: OmsProjectConfig;

  private _defaultProfile: BuildProfile;
  private _headlessProfile: BuildProfile;
  private _ctx: ServerContext;
  private _uuidManager: UUIDManager;
  private _uuidProvider: UUIDProvider;
  private _buildRecord: BuildRecord;
  private _headlessBuildRecord: BuildRecord | undefined;
  private _fileWatcher: chokidar.FSWatcher | undefined;
  private _fileWatcherPhase = FileWatcherPhase.Closed;
  private _fileQueueConsumerScheduled = false;
  private _fileQueueConsumerProfiles = new Set<BuildProfileId>();
  private _sourceFiles = new Set<string>();
  private _passiveWatchedFiles = new Set<string>();
  private _domains: Record<string, Domain> = {};
  private _domainSourceRootMap: Array<{
    domainId: string;
    sourceRoot: string;
  }> = [];

  private _domainConfigWatchers: Record<string, OmsDomainConfigWatcher> = {};

  private _fileQueue: Record<string, 'add' | 'delete' | 'change'> = {};
  private _profileBuildExtras: Partial<Record<BuildProfileId, BuildExtras>> = {};
  private _profileDependencySnapshots: Record<BuildProfileId, ProfileDependencySnapshot> = {
    [BuildProfileId.default]: {
      inferredFiles: [],
      entryFiles: new Set(),
    },
    [BuildProfileId.headless]: {
      inferredFiles: [],
      entryFiles: new Set(),
    },
  };

  private _activeBuildRevision: ActiveBuildRevision | undefined;
  private _profileBuildRequests = new Set<ProfileBuildRequest>();
  private _closing = false;
  private _revisionInProgress = false;
  private _followupRevisionQueued = false;
  private _taskQueue = new TaskQueue<{
    'build': () => void;
    'inlineUUIDs': () => void;
    'build-prod': () => void;
    'update-build-options': () => void;
    'update-config': () => void;
    'update-domain-configs': () => void;
  }>();

  private _createHeadlessBuildRecord(config: OmsProjectConfig) {
    return new BuildRecord({
      projectRoot: this._projectPath,
      title: `headless-build`,
      outDir: this._headlessProfile.outDir,
      config,
      treeShake: false,
      headless: true,
      ccEnvParams: {
        platform: 'nodejs',
        debug: true,
        headless: true,
      },
    });
  }

  private async _syncHeadlessProfile(config: OmsProjectConfig) {
    if (config.profiles.headless) {
      if (!this._headlessBuildRecord) {
        await initializeHeadlessProfile(this._headlessProfile);
        this._headlessBuildRecord = this._createHeadlessBuildRecord(config);
      }
      return;
    }
    if (!this._headlessBuildRecord) {
      return;
    }
    this._headlessBuildRecord = undefined;
    await Promise.all([
      fs.remove(this._headlessProfile.outDir),
      fs.remove(this._headlessProfile.typingOutDir),
    ]);
  }

  private async _updateDomains() {
    await Promise.all(Object.values(this._domainConfigWatchers).map((watcher) => watcher.close()));
    this._domainConfigWatchers = {};
    this._domains = {};
    this._domainSourceRootMap.length = 0;
    const domainPromises: Array<Promise<void>> = [];
    const mainDomainRoot = join(this._projectPath);
    domainPromises.push(this._addDomain(
      mainDomainId, mainDomainRoot, 'src',
    ));
    for (const { name: extensionName, path: extensionPath } of this._buildOptions
      .extensionBuildOptions) {
      const extensionDomainRoot = join(extensionPath);
      domainPromises.push(this._addDomain(
        extensionName, extensionDomainRoot, 'oms/src',
      ));
    }
    await Promise.all(domainPromises);
    await writeOmsTypingDeclarations(this._defaultProfile.typingOutDir, this._domains);
    if (this._headlessBuildRecord) {
      await writeOmsTypingDeclarations(this._headlessProfile.typingOutDir, this._domains);
    }
  }

  private async _reloadDomainsAndFileWatcher() {
    this._profileBuildExtras = {};
    this._fileWatcherPhase = FileWatcherPhase.Starting;
    this._fileQueueConsumerScheduled = true;
    this._fileQueueConsumerProfiles = new Set(allBuildProfileIds);
    this._fileQueue = {};
    await this._closeFileWatcher();
    await this._updateDomains();
    await this._restartFileWatcher();
    await this._collectInitialSourceFiles();
    this._fileQueueConsumerScheduled = false;
    this._fileQueueConsumerProfiles.clear();
  }

  private async _addDomain(domainId: string, domainRoot: string,
    preferredDomainSourceRoot: string) {
    const domainConfigWatcher = new OmsDomainConfigWatcher({
      domainRoot,
      preferredSourceRoot: preferredDomainSourceRoot,
      context: developmentConfigContext,
    });
    this._domainConfigWatchers[domainId] = domainConfigWatcher;
    const domainConfig = await domainConfigWatcher.ready();
    domainConfigWatcher.on('configUpdated', () => {
      this._queueDomainConfigUpdate(domainId).catch((err) => {
        logger.error(`Failed to update OMS domain config for ${domainId}: %o`, err);
      });
    });
    const domainProfiles = domainId === mainDomainId
      ? [
        makeDefaultDomainProfile(this._config.profiles.default),
        ...(this._config.profiles.headless
          ? [makeHeadlessDomainProfile(this._config.profiles.headless)]
          : []),
      ]
      : [makeDefaultDomainProfile(undefined)];
    const domain = this._domains[domainId] = new Domain(
      domainId,
      domainRoot,
      domainConfig.partitions,
      domainConfig.exports,
      this._uuidManager,
      domainProfiles,
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
  }

  private async _createProductionDomains(config: OmsProjectConfig) {
    const domains: Record<string, Domain> = {};
    const domainDefinitions = [
      {
        id: mainDomainId,
        root: this._projectPath,
        preferredSourceRoot: 'src',
      },
      ...this._buildOptions.extensionBuildOptions.map(({ name, path }) => ({
        id: name,
        root: path,
        preferredSourceRoot: 'oms/src',
      })),
    ];

    for (const definition of domainDefinitions) {
      const domainConfig = await readOmsDomainConfig(definition.root, {
        preferredSourceRoot: definition.preferredSourceRoot,
        context: productionConfigContext,
      });
      const domainProfiles = definition.id === mainDomainId
        ? [
          makeDefaultDomainProfile(config.profiles.default),
          ...(config.profiles.headless
            ? [makeHeadlessDomainProfile(config.profiles.headless)]
            : []),
        ]
        : [makeDefaultDomainProfile(undefined)];
      const domain = domains[definition.id] = new Domain(
        definition.id,
        definition.root,
        domainConfig.partitions,
        domainConfig.exports,
        this._uuidManager,
        domainProfiles,
        domainConfig.exportPackageName,
      );
      for (const sourceRoot of domain.sourceRoots) {
        for await (const file of walkWatchableFiles(sourceRoot)) {
          await domain.addSourceFile(file, false);
        }
      }
    }

    return domains;
  }

  private async _queueDomainConfigUpdate(domainId: string) {
    if (this._closing) {
      return;
    }
    await this._taskQueue.queueTask({
      type: 'update-domain-configs',
      exec: async () => {
        logger.debug(`Updating OMS domains because domain config changed: ${domainId}`);
        await this._reloadDomainsAndFileWatcher();
      },
    });
    this._queuePassiveBuild(`domain config updated: ${domainId}`);
  }

  private async _restartFileWatcher() {
    await this._closeFileWatcher();
    this._fileWatcherPhase = FileWatcherPhase.Starting;

    const readyPromiseWithResolvers = promiseWithResolvers<void>();
    let ready = false;
    const sourceRoots = this._domainSourceRootMap.map(({ sourceRoot }) => sourceRoot);
    const watcher = this._fileWatcher = chokidar.watch(sourceRoots, {
      ignoreInitial: true,
      ignored: (path, stats) => {
        // Chokidar supplies forward slashes, even on Windows; dependency keys use native
        // separators.
        // Explicit build dependencies (e.g. asset .meta files) must bypass the source-extension
        // filter.
        if (this._passiveWatchedFiles.has(normalize(path))) {
          return false;
        }
        return shouldIgnoreWatchedPath(path, stats);
      },
      persistent: true,
    });
    watcher
      .on('ready', () => {
        ready = true;
        logger.debug('Watcher ready');
        this._fileWatcherPhase = FileWatcherPhase.Ready;
        readyPromiseWithResolvers.resolve();
      })
      .on('error', (error) => {
        logger.error('Watcher error: %s', error);
        if (!ready) {
          readyPromiseWithResolvers.reject(error);
        }
      })
      .on('all', (event, path) => {
        logger.debug('Watcher event: %s, Path: %s', event, path);
      })
      .on('add', (path) => {
        if (this._passiveWatchedFiles.has(path)) {
          this._queuePassiveBuild('dependency added');
          return;
        }
        if (this._queueFileAdd(path)) {
          this._queuePassiveBuild('file added');
        }
      })
      .on('change', (path) => {
        if (this._passiveWatchedFiles.has(path)) {
          this._queuePassiveBuild('file changed');
          return;
        }
        if (!this._getDomainId(path)) {
          return;
        }
        switch (this._fileQueue[path]) {
        case 'add':
        case 'delete':
          return;
        }
        this._fileQueue[path] = 'change';
        this._queuePassiveBuild('file changed');
      })
      .on('unlink', (path) => {
        if (this._passiveWatchedFiles.has(path)) {
          // Re-arm deleted inode watches after Chokidar finishes closing the old path.
          queueMicrotask(() => {
            if (!watcher.closed && this._passiveWatchedFiles.has(path)) {
              watcher.add(path);
            }
          });
          this._queuePassiveBuild('file deleted');
          return;
        }
        if (!this._getDomainId(path)) {
          return;
        }
        this._sourceFiles.delete(path);
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

    await readyPromiseWithResolvers.promise;
  }

  private async _collectInitialSourceFiles() {
    const sourceRoots = new Set(this._domainSourceRootMap.map(({ sourceRoot }) => sourceRoot));
    for (const sourceRoot of sourceRoots) {
      for await (const file of walkWatchableFiles(sourceRoot)) {
        this._queueFileAdd(file);
      }
    }
  }

  private _queueFileAdd(path: string) {
    if (!this._getDomainId(path)) {
      return false;
    }
    if (this._fileQueue[path] === 'delete') {
      this._sourceFiles.add(path);
      this._fileQueue[path] = 'add';
      return true;
    }
    if (this._sourceFiles.has(path)) {
      return false;
    }
    this._sourceFiles.add(path);
    this._fileQueue[path] = 'add';
    return true;
  }

  private async _closeFileWatcher() {
    if (!this._fileWatcher) {
      this._passiveWatchedFiles.clear();
      this._sourceFiles.clear();
      this._fileWatcherPhase = FileWatcherPhase.Closed;
      return;
    }
    const watcher = this._fileWatcher;
    this._fileWatcher = undefined;
    await watcher.close();
    this._passiveWatchedFiles.clear();
    this._sourceFiles.clear();
    this._fileWatcherPhase = FileWatcherPhase.Closed;
  }

  private async _makeEntries(
    profileId: string,
    opts: ProfileBuildOptions = {},
    domains: Record<string, Domain> = this._domains,
  ) {
    const entries: Record<string, InternalBuildEntry> = {};
    const autoRunInfos: Array<{
      entryId: string;
      bundleId: string;
      isEditorEntry: boolean;
    }> = [];
    const exportEntries: Record<string, string> = {};
    for (const domain of Object.values(domains)) {
      const domainEntrySpecs = domain.getEntrySpecs(profileId, opts);
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
      if (isPathInside(sourceRoot, path)) {
        return domainId;
      }
    }
    return undefined;
  }

  private _requestProfiles(
    reason: string,
    passive: boolean,
    profiles: BuildProfileId[],
  ): ProfileBuildBatch {
    this._assertOpen();
    const requestedProfiles = normalizeBuildProfiles(profiles);
    const activeRevision = this._activeBuildRevision;
    const attachToActiveRevision = !passive
      && !this._followupRevisionQueued
      && activeRevision !== undefined
      && requestedProfiles.every((profile) => activeRevision.profileResults.has(profile)
        && !activeRevision.settledProfiles.has(profile));
    if (attachToActiveRevision) {
      requestedProfiles.forEach((profile) => activeRevision.state.activeProfiles.add(profile));
    }
    const profileResults = new Map<BuildProfileId, Promise<BuildProfileResult>>();
    for (const profile of requestedProfiles) {
      const profileBuild = attachToActiveRevision
        ? activeRevision.profileResults.get(profile)
        : this._queueProfileBuild(reason, passive, profile);
      assert.ok(profileBuild);
      profileResults.set(profile, profileBuild);
    }
    return {
      waitFor: async (requestedProfiles) => {
        const profilePromises = [...new Set(requestedProfiles)].map((profile) => {
          const result = profileResults.get(profile);
          assert.ok(result, `Profile ${profile} was not requested in this build batch`);
          return result.then((profileResult) => [profile, profileResult] as const);
        });
        const resultsByProfile: BuildProfileResults = {};
        for (const [profile, result] of await Promise.all(profilePromises)) {
          resultsByProfile[profile] = result;
        }
        return resultsByProfile;
      },
    };
  }

  private _assertOpen() {
    if (this._closing) {
      throw new OmsWatcherClosedError();
    }
  }

  private _queueProfileBuild(reason: string, passive: boolean, profile: BuildProfileId) {
    logger.debug(`Will queue ${profile} profile build. Reason: ${reason}`);
    this._fileQueueConsumerScheduled = true;
    this._fileQueueConsumerProfiles.add(profile);
    const request: ProfileBuildRequest = {
      profile,
      passive,
      result: promiseWithResolvers<BuildProfileResult>(),
      settled: false,
    };
    this._profileBuildRequests.add(request);
    const taskPromise = this._taskQueue.queueTask({
      type: 'build',
      mergeArgs: [request],
      exec: async (ctx) => {
        ctx.acceptMerge = true;
        const state: BuildState = {
          hasPassiveRequest: passive,
          activeProfiles: new Set(passive ? [] : [profile]),
          requests: [request],
          profiles: new Set([profile]),
        };
        const applyRequest = (input: ProfileBuildRequest | undefined) => {
          if (!input) {
            return;
          }
          state.requests.push(input);
          state.profiles.add(input.profile);
          if (input.passive) {
            state.hasPassiveRequest = true;
          } else {
            state.activeProfiles.add(input.profile);
          }
        };
        for (const mergeArgs of ctx.initialMergeArgs) {
          applyRequest(mergeArgs[0] as ProfileBuildRequest | undefined);
        }

        let interruptedByAbort = false;
        for (; ;) {
          const timerInterruptController = new AbortController();
          let interruptedByMerge = false;
          const onMerge = (mergeArgs: unknown[] | undefined) => {
            applyRequest(mergeArgs?.[0] as ProfileBuildRequest | undefined);
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
            logger.debug(`Waiting for further merge signal...`);
            await setTimeout(100, undefined, {
              signal: timerInterruptController.signal,
            });
          } catch (err) {
            if (typeof err === 'object' && err !== null && 'name' in err && err
              .name === 'AbortError') {
              if (interruptedByMerge) {
                logger.debug(`Build merged.`);
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

        logger.info(`Build started. Reason: ${reason}`);
        ctx.acceptMerge = false;
        return await this._execBuild(state);
      },
    });
    taskPromise.catch((err) => {
      this._rejectProfileBuildRequest(request, err instanceof MergedTaskExecError
        ? err
          .cause
        : err);
    });
    return request.result.promise;
  }

  private _queuePassiveBuild(reason: string) {
    if (this._closing) {
      return;
    }
    if (this._fileWatcherPhase !== FileWatcherPhase.Ready) {
      return;
    }
    if (this._fileQueueConsumerScheduled
      && allBuildProfileIds.every((profile) => this._fileQueueConsumerProfiles.has(profile))) {
      return;
    }
    if (this._revisionInProgress) {
      this._followupRevisionQueued = true;
    }
    this._requestProfiles(reason, true, allBuildProfileIds).waitFor(allBuildProfileIds)
      .catch((err) => {
        if (err instanceof OmsWatcherClosedError) {
          return;
        }
        logger.error(`Build failed: ${err}`);
      });
  }

  private async _execBuild(state: BuildState): Promise<void> {
    this._followupRevisionQueued = false;
    this._revisionInProgress = true;
    const activeBuildRevision: ActiveBuildRevision = {
      state,
      profileResults: new Map([...state.profiles].map((profile) => {
        const request = state.requests.find((request) => request.profile === profile);
        assert.ok(request, `Missing ${profile} profile request for active revision`);
        return [profile, request.result.promise];
      })),
      settledProfiles: new Set(),
    };
    this._activeBuildRevision = activeBuildRevision;
    try {
      const startState = {
        time: Date.now(),
        profiles: [...state.profiles],
      };
      await this._ctx.ipc.invoke('build-start', startState);

      const profileResults = new Map<BuildProfileId, BuildProfileResult>();
      const profileBuildStart = Date.now();
      try {
        const prepareStart = Date.now();
        const entryChanged = await this._executeFileQueue();
        if (entryChanged) {
          this._profileBuildExtras = {};
        }
        await this._uuidManager.emit();
        logger.info(`Build prepare done in ${Date.now() - prepareStart}ms`);

        const profileBuilds: Array<Promise<BuildProfileResult>> = [];
        for (const profile of state.profiles) {
          const profileBuild = (async () => {
            const result = await this._runProfileBuild(profile);
            profileResults.set(profile, result);
            activeBuildRevision.settledProfiles.add(profile);
            this._resolveProfileRequests(state.requests, profile, result);
            if (state.hasPassiveRequest && !state.activeProfiles.has(profile)) {
              this.emit('passive-profile-build-end', { profile, result });
            }
            return result;
          })();
          profileBuilds.push(profileBuild);
        }
        await Promise.all(profileBuilds);
      } catch (err) {
        const preparationFailure = makeBuildFailureResult('OMS build preparation failed', err);
        for (const profile of state.profiles) {
          profileResults.set(profile, preparationFailure);
          activeBuildRevision.settledProfiles.add(profile);
        }
        this._resolveAllProfileRequests(state.requests, preparationFailure);
        if (state.hasPassiveRequest) {
          for (const profile of state.profiles) {
            if (!state.activeProfiles.has(profile)) {
              this.emit('passive-profile-build-end', { profile, result: preparationFailure });
            }
          }
        }
      }

      await this._ctx.ipc.invoke('build-end', {
        time: Date.now(),
        startState,
      });
      logger.info(`Profile builds done in ${Date.now() - profileBuildStart}ms`);

      const elapsedMs = Date.now() - startState.time;
      const failureMessages: string[] = [];
      for (const [profile, result] of profileResults) {
        if (!result.ok) {
          failureMessages.push(`${profile}: ${result.error.message}`);
        }
      }
      if (failureMessages.length === 0) {
        logger.info(`Build done in ${elapsedMs}ms`);
      } else {
        logger.error(`Build failed in ${elapsedMs}ms:\n${failureMessages.join('\n')}`);
      }
      if (state.hasPassiveRequest && !state.activeProfiles.has(BuildProfileId.default)) {
        const defaultResult = profileResults.get(BuildProfileId.default);
        const headlessResult = profileResults.get(BuildProfileId.headless);
        assert.ok(defaultResult, 'Passive revision is missing the default profile result');
        assert.ok(headlessResult, 'Passive revision is missing the headless profile result');
        this.emit('passive-build-end', {
          profileResults: {
            default: defaultResult,
            headless: headlessResult,
          },
        });
      }
    } finally {
      if (this._activeBuildRevision === activeBuildRevision) {
        this._activeBuildRevision = undefined;
      }
      this._revisionInProgress = false;
    }
  }

  private async _runProfileBuild(profile: BuildProfileId): Promise<BuildProfileResult> {
    const start = Date.now();
    try {
      switch (profile) {
      case BuildProfileId.default:
        return await this._runDefaultProfileBuild();
      case BuildProfileId.headless:
        return await this._runHeadlessProfileBuild();
      default:
        throw new Error(`Unknown OMS build profile: ${String(profile)}`);
      }
    } catch (err) {
      return makeBuildFailureResult(`${profile} profile build failed`, err);
    } finally {
      logger.info(`${profile} profile build done in ${Date.now() - start}ms`);
    }
  }

  private async _runDefaultProfileBuild(): Promise<BuildProfileResult> {
    let extras = this._profileBuildExtras[BuildProfileId.default];
    let newExtras: BuildExtras | undefined;
    let buildResult: InternalBuildResult;
    if (extras) {
      buildResult = await this._buildRecord.build();
    } else {
      extras = {
        entryFiles: new Set(),
      };
      newExtras = extras;
      const profileBuildOptions = { editor: true };
      const { entries } = await this._makeEntries(BuildProfileId.default, profileBuildOptions);
      for (const domain of Object.values(this._domains)) {
        for (const implicitEntry of domain.getImplicitEntries(BuildProfileId.default,
          profileBuildOptions)) {
          extras.entryFiles.add(implicitEntry);
        }
      }
      buildResult = await this._buildRecord.rebuild({
        entries,
        uuidProvider: this._uuidProvider,
        domains: this._domains,
        config: this._config,
        profileBuildConfig: undefined,
      });
    }
    if (!buildResult.ok) {
      this._publishProfileDependencies(BuildProfileId.default, [
        ...this._profileDependencySnapshots[BuildProfileId.default].inferredFiles,
        ...(buildResult.inferredFiles ?? []),
      ], extras.entryFiles);
      return {
        ok: false,
        error: buildResult.error,
      };
    }

    if (newExtras) {
      this._profileBuildExtras[BuildProfileId.default] = newExtras;
    }
    this._publishProfileDependencies(BuildProfileId.default,
      buildResult.inferredFiles,
      extras.entryFiles);
    const affectedFiles = await this._writeRuntimeLoaderAssets();
    await this._saveCentralizedUUIDs();
    return {
      ok: true,
      affectedFiles,
    };
  }

  private async _runHeadlessProfileBuild(): Promise<BuildProfileResult> {
    const buildRecord = this._headlessBuildRecord;
    if (!buildRecord) {
      this._publishProfileDependencies(BuildProfileId.headless, [], new Set());
      return {
        ok: true,
        affectedFiles: [],
      };
    }

    let extras = this._profileBuildExtras[BuildProfileId.headless];
    let newExtras: BuildExtras | undefined;
    let buildResult: InternalBuildResult;
    if (extras) {
      buildResult = await buildRecord.build();
    } else {
      extras = {
        entryFiles: new Set(),
      };
      newExtras = extras;
      const profileBuildOptions = { dynamicExports: false };
      const { entries } = await this._makeEntries(BuildProfileId.headless, profileBuildOptions);
      for (const domain of Object.values(this._domains)) {
        for (const implicitEntry of domain.getImplicitEntries(BuildProfileId.headless,
          profileBuildOptions)) {
          extras.entryFiles.add(implicitEntry);
        }
      }
      buildResult = await buildRecord.rebuild({
        entries,
        uuidProvider: this._uuidProvider,
        domains: this._domains,
        config: this._config,
        profileBuildConfig: this._config.profiles.headless?.build,
      });
    }
    if (!buildResult.ok) {
      this._publishProfileDependencies(BuildProfileId.headless, [
        ...this._profileDependencySnapshots[BuildProfileId.headless].inferredFiles,
        ...(buildResult.inferredFiles ?? []),
      ], extras.entryFiles);
      return {
        ok: false,
        error: buildResult.error,
      };
    }

    if (newExtras) {
      this._profileBuildExtras[BuildProfileId.headless] = newExtras;
    }
    this._publishProfileDependencies(BuildProfileId.headless,
      buildResult.inferredFiles,
      extras.entryFiles);
    return {
      ok: true,
      affectedFiles: [],
    };
  }

  private _resolveProfileRequests(
    requests: ProfileBuildRequest[],
    profile: BuildProfileId,
    result: BuildProfileResult,
  ) {
    for (const request of requests) {
      if (request.profile !== profile || request.settled) {
        continue;
      }
      request.settled = true;
      this._profileBuildRequests.delete(request);
      request.result.resolve(result);
    }
  }

  private _resolveAllProfileRequests(requests: ProfileBuildRequest[], result: BuildProfileResult) {
    for (const request of requests) {
      if (request.settled) {
        continue;
      }
      request.settled = true;
      this._profileBuildRequests.delete(request);
      request.result.resolve(result);
    }
  }

  private _rejectProfileBuildRequest(request: ProfileBuildRequest, error: unknown) {
    if (request.settled) {
      return;
    }
    request.settled = true;
    this._profileBuildRequests.delete(request);
    request.result.reject(error);
  }

  private _rejectProfileBuildRequests(error: unknown) {
    for (const request of [...this._profileBuildRequests]) {
      this._rejectProfileBuildRequest(request, error);
    }
  }

  private async _writeRuntimeLoaderAssets() {
    const affectedFiles: string[] = [];
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
    return affectedFiles;
  }

  /**
   * Publishes dependencies at profile completion. Successful output replaces the snapshot;
   * failed compilation retains the successful snapshot plus newly discovered dependencies.
   *
   * As before, a dependency can change between its first read and listener registration,
   * or while watcher.add() activates; Chokidar has no public per-path readiness event.
   */
  private _publishProfileDependencies(
    profile: BuildProfileId,
    inferredFiles: readonly string[],
    entryFiles: ReadonlySet<string>,
  ) {
    this._profileDependencySnapshots[profile] = {
      inferredFiles: [...inferredFiles],
      entryFiles: new Set(entryFiles),
    };
    const allInferredFiles = new Set(
      Object.values(this._profileDependencySnapshots).flatMap((snapshot) => [...snapshot
        .inferredFiles]),
    );
    const allEntryFiles = new Set(
      Object.values(this._profileDependencySnapshots).flatMap((snapshot) => [...snapshot
        .entryFiles]),
    );

    logger.debug(`${profile} profile dependencies published: %s`, [...inferredFiles]);
    const passiveWatchedFiles = this._passiveWatchedFiles;
    const watcher = this._fileWatcher;
    assert.ok(watcher, 'OMS file watcher is not started');
    for (const file of passiveWatchedFiles) {
      if (!allInferredFiles.has(file) || allEntryFiles.has(file)) {
        logger.debug('Unwatch file: %s', file);
        watcher.unwatch(file);
        passiveWatchedFiles.delete(file);
      }
    }
    for (const file of allInferredFiles) {
      if (passiveWatchedFiles.has(file)) {
        continue;
      }
      if (allEntryFiles.has(file)) {
        continue;
      }
      logger.debug('Passive watch file: %s', file);
      watcher.add(file);
      passiveWatchedFiles.add(file);
    }
  }

  private async _renderMetadataFile(autoRunInfos: AutoRunInfos, exportEntries:
  Record<string, string>) {
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
    this._fileQueueConsumerScheduled = false;
    this._fileQueueConsumerProfiles.clear();
    let entryChanged = false;
    for (const [file, operation] of Object.entries(fileQueue)) {
      if (operation === 'add') {
        entryChanged = (await this._addWatchFile(file)) || entryChanged;
      } else if (operation === 'delete') {
        entryChanged = this._removeWatchFile(file) || entryChanged;
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
    const shouldRebuildBundles = await domain.addSourceFile(path, true);
    return shouldRebuildBundles;
  }

  private _removeWatchFile(path: string) {
    const domainId = this._getDomainId(path);
    if (!domainId) {
      return false;
    }
    const domain = this._domains[domainId];
    assert.ok(domain, `Domain ${domainId} not found`);
    const shouldRebuildBundle = domain.removeSourceFile(path);
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
      let code: string;
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

function shouldIgnoreWatchedPath(path: string, stats?: Stats) {
  if (stats?.isFile()) {
    return !shouldWatchFile(path);
  }
  return false;
}

function shouldWatchFile(path: string) {
  const lowercase = path.toLocaleLowerCase();
  if (lowercase.endsWith('.d.ts')) {
    return false;
  }
  if (/^\.env(?:\..*)?$/.test(basename(path))) {
    return true;
  }
  if (/\.[mc]?[jt]sx?$/.test(lowercase)) {
    return true;
  }
  if (/.jsonc?$/.test(lowercase)) {
    return true;
  }
  return false;
}

async function* walkWatchableFiles(root: string): AsyncGenerator<string> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return;
    }
    throw err;
  }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      yield* walkWatchableFiles(path);
    } else if (entry.isFile() && shouldWatchFile(path)) {
      yield path;
    }
  }
}

interface BuildExtras {
  entryFiles: Set<string>;
}

interface ProfileDependencySnapshot {
  inferredFiles: readonly string[];
  entryFiles: ReadonlySet<string>;
}

function normalizeBuildProfiles(profiles: BuildProfileId[] | undefined): BuildProfileId[] {
  const requestedProfiles = [...new Set(profiles ?? allBuildProfileIds)];
  if (requestedProfiles.length === 0) {
    throw new Error('OMS build requires at least one profile');
  }
  for (const profile of requestedProfiles) {
    if (!allBuildProfileIds.includes(profile)) {
      throw new Error(`Unknown OMS build profile: ${String(profile)}`);
    }
  }
  return requestedProfiles;
}

function makeBuildFailureResult(title: string, error: unknown): BuildProfileResult {
  if (error instanceof Error) {
    return {
      ok: false,
      error: {
        message: `${title}: ${error.message}`,
        stack: error.stack,
      },
    };
  }
  return {
    ok: false,
    error: {
      message: `${title}: ${String(error)}`,
      stack: undefined,
    },
  };
}

type AutoRunInfos = Array<{
  entryId: string;
  bundleId: string;
  isEditorEntry: boolean;
}>;
