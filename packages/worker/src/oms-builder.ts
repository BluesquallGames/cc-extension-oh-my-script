import { dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';
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
import EventEmitter from 'node:events';
import { transformCCComponent } from './features/babel-plugin-cc-component.js';
import assert from 'node:assert';
import dedent from 'dedent';

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
    this._mainBundleSourceRoot = join(this._projectPath, 'src');
  }

  async rebuild() {
    await this._rebuild();
  }

  private _projectPath: string;
  private _mainBundleSourceRoot: string;
  private _buildRecord: BuildRecord<BuildExtras> | undefined;
  private _watcher: chokidar.FSWatcher | undefined;

  private async _clean() {
    await this._buildRecord?.abort();
    this._buildRecord = undefined;
    if (this._watcher) {
      await this._watcher.close();
      this._watcher = undefined;
    }
  }

  private async _rebuild() {
    await this._clean();

    const sourceRoot = this._mainBundleSourceRoot;
    const outDir = resolve(this._projectPath, 'temp', 'oms', 'out');
    await fs.ensureDir(outDir);
    await fs.emptyDir(outDir);
    await fs.outputJSON(join(outDir, 'package.json'), {
      type: 'module',
    }, {
      spaces: 2,
    });

    const buildRecord = new BuildRecord<BuildExtras>({
      sourceRoot: this._mainBundleSourceRoot,
      outDir,
      shadowDir: resolve(this._projectPath, 'assets/shadow-source'),
    });

    const currentWatchedInferredFiles = new Set<string>();
    const bundles: Record<string, Bundle> = {};
    const mainBundle = new Bundle(mainBundleId, this._mainBundleSourceRoot, resolve(this._projectPath, 'assets/oms-index.ts'));
    bundles[mainBundle.id] = mainBundle;

    let watcherReady = false;

    const makeBundleEntryFilenameNoExtension = (bundleId: string) => {
      return `bundle-${bundleId}`;
    };

    const build = (entryChanged: boolean) => {
      if (!watcherReady) {
        return;
      }

      if (!entryChanged) {
        buildRecord.requestBuild();
        return;
      }

      const bundleEntries: Record<string, string> = {};
      const buildExtras: BuildExtras = {
        bundles: [],
      };
      for (const [bundleId, bundle] of Object.entries(bundles)) {
        if (bundle.empty) {
          continue;
        }
        bundleEntries[makeBundleEntryFilenameNoExtension(bundleId)] = bundle.entry;
        buildExtras.bundles.push(bundle);
      }

      buildRecord.rebuild({
        entries: bundleEntries,
      }, buildExtras);
    };

    const watcher = chokidar.watch(sourceRoot, {
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
    watcher
      .on('ready', () => {
        logger.debug('Watcher ready');
        watcherReady = true;
        build(true);
      })
      .on('error', (error) => {
        logger.error('Watcher error: %s', error);
      })
      .on('all', (event, path) => {
        logger.debug('Watcher event: %s, Path: %s', event, path);
      })
      .on('add', (path) => {
        if (currentWatchedInferredFiles.has(path)) {
          return;
        }
        const bundleId = this._getBundleId(path);
        if (!bundleId) {
          build(false);
          return;
        }
        const bundle = bundles[bundleId];
        assert.ok(bundle, `Bundle ${bundleId} not found`);
        const buildEntryChanged = bundle.addSourceFile(path);
        build(buildEntryChanged);
      })
      .on('change', (path) => {
        build(false);
      })
      .on('unlink', (path) => {
        const bundleId = this._getBundleId(path);
        if (!bundleId) {
          build(false);
          return;
        }
        const bundle = bundles[bundleId];
        assert.ok(bundle, `Bundle ${bundleId} not found`);
        const bundleEntryChanged = bundle.deleteSourceFile(path);
        build(bundleEntryChanged);
      })
      .on('addDir', (path) => {
        void 0;
      })
      .on('unlinkDir', (path) => {
        void 0;
      })
    ;

    let nBuildEnds = 0;
    buildRecord.on('build-failed', () => {
      this._ctx.ipc.invoke('build-failed', {}).catch((err) => {
        logger.error(err);
      });
    });

    buildRecord.on('build-end', async (buildResult, extras) => {
      nBuildEnds++;

      const affectedFiles: string[] = [];
      for (const bundle of extras.bundles) {
        const proxyFile = bundle.proxyFile;
        const bundleEntryOutFile = resolve(outDir, `${makeBundleEntryFilenameNoExtension(bundle.id)}.js`);
        const proxyFileContent = this._renderProxyFile(proxyFile, bundleEntryOutFile, bundle.id);
        await fs.outputFile(proxyFile, proxyFileContent, 'utf8');
        affectedFiles.push(proxyFile);
      }
      this._ctx.ipc.invoke('build-success', {
        affectedFiles: [...affectedFiles],
      }).catch((err) => {
        logger.error(err);
      });

      logger.debug(`[Build x ${nBuildEnds}] Build end, inferred files: %s`, buildResult.inferredFiles);
      for (const file of currentWatchedInferredFiles) {
        if (!buildResult.inferredFiles.includes(file)) {
          logger.debug('Unwatch file: %s', file);
          watcher.unwatch(file);
        }
      }
      for (const file of buildResult.inferredFiles) {
        if (!currentWatchedInferredFiles.has(file)) {
          logger.debug('Watch file: %s', file);
          watcher.add(file);
        }
      }
      currentWatchedInferredFiles.clear();
      for (const file of buildResult.inferredFiles) {
        currentWatchedInferredFiles.add(file);
      }
    });

    this._watcher = watcher;
  }

  private _getBundleId(path: string): string | undefined {
    return mainBundleId;
  }

  private *_listEntries(sourceRoot: string) {
    if (!fs.existsSync(sourceRoot)) {
      return;
    }
    for (const entry of readDirRecurse(sourceRoot)) {
      if (/\.[cm]?[jt]s$/.test(entry)) {
        yield join(sourceRoot, entry);
      }
    }
  }

  private _renderProxyFile(proxyFilePath: string, bundleEntryPath: string, bundleId: string) {
    let source = '';
    source
      += `/// This file is generated by 'Oh My Script!' extension.\n`
        + `/// It serves as entry of bundle ${bundleId}.\n`
        + `/// Neither don't edit it, nor add it into version control system(eg. Git).\n`
        + `\n`;
    source += `import '${makeRelativeImportSpecifier(dirname(proxyFilePath), bundleEntryPath)}';\n`;
    return source;
  }
}

interface BuildExtras {
  bundles: Bundle[];
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

function makeRelativeImportSpecifier(from: string, to: string) {
  let path = relative(from, to).replace(/\\/g, '/');
  if (path.startsWith('./')) {
    path = './' + path;
  }
  return path;
}

function makeAbsoluteImportSpecifier(file: string) {
  return file.replace(/\\/g, '/');
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

  /**
   * @returns True if it cause the bundle's entry changed.
   */
  addSourceFile(sourceFile: string): boolean {
    if (this._sourceFiles.includes(sourceFile)) {
      logger.warn(`Bundle ${this._id} already includes ${sourceFile}`);
      return false;
    }
    this._sourceFiles.push(sourceFile);
    if (this._isComponentModule(sourceFile)) {
      this._componentModules.push(sourceFile);
      this._invalidateEntry();
      return true;
    } else if (this._isIndexModule(sourceFile)) {
      this._indexModule = sourceFile;
      this._invalidateEntry();
      return true;
    }
    return false;
  }

  /**
   * @returns True if it cause the bundle's entry changed.
   */
  deleteSourceFile(sourceFile: string) {
    const indexInBundle = this._sourceFiles.indexOf(sourceFile);
    if (indexInBundle < 0) {
      return false;
    }
    this._sourceFiles.splice(indexInBundle, 1);
    if (this._indexModule === sourceFile) {
      this._indexModule = sourceFile;
      this._invalidateEntry();
      return true;
    } else {
      const componentModuleIndex = this._componentModules.findIndex((m) => m === sourceFile);
      if (componentModuleIndex >= 0) {
        this._componentModules.splice(componentModuleIndex, 1);
        this._invalidateEntry();
        return true;
      }
    }
    return false;
  }

  private _sourceFiles: string[] = [];
  private _indexModule = '';
  private _componentModules: string[] = [];
  private _entryDirty = true;
  private _entrySource = '';

  private _isComponentModule(path: string) {
    return /\.component\.[cm]?[jt]s$/.test(path.toLocaleLowerCase());
  }

  private _isIndexModule(path: string) {
    const { dir, name } = parse(path);
    return dir === this._sourceRoot && /index\.[cm]?[jt]s$/.test(name.toLocaleLowerCase());
  }

  private _invalidateEntry() {
    this._entryDirty = true;
    this._entrySource = '';
  }

  private _makeEntrySource() {
    let source = '';
    if (this._indexModule) {
      source
        += `/// The index module.\n`
          + `import '${makeAbsoluteImportSpecifier(this._indexModule)}';\n`;
    }
    for (const componentModule of this._componentModules) {
      source += `import '${makeAbsoluteImportSpecifier(componentModule)}';\n`;
    }
    // Explicitly mark this as a module.
    source += `export {};\n`;
    return source;
  }
}

interface InternalBuildOptions {
  entries: Record<string, string>;
}

interface BuildResult {
  inferredFiles: string[];
}

class BuildRecord<TBuildExtras> extends EventEmitter<{
  'build-start': [];
  'build-end': [BuildResult, TBuildExtras];
  'build-failed': [{
    message: string;
    stack?: string;
  }];
}> {
  constructor(options: {
    outDir: string;
    shadowDir: string;
    sourceRoot: string;
  }) {
    super();
    this._outDir = options.outDir;
    this._shadowDir = options.shadowDir;
    this._sourceRoot = options.sourceRoot;
  }

  get busy() {
    return this._isBuilding;
  }

  async abort() {
    this._nBuildRequests = 0;
    this._cache = undefined;
  }

  rebuild(options: InternalBuildOptions, extras: TBuildExtras) {
    Object.assign(this._buildOptions, options);
    this._extras = extras;
    this.requestBuild();
  }

  requestBuild() {
    ++this._nBuildRequests;
    if (!this._isBuilding) {
      this._loopBuild();
    }
  }

  private _nBuildRequests = 0;
  private _isBuilding: boolean = false;
  private _cache: rollup.RollupCache | undefined;
  private _sourceRoot: string;
  private _outDir: string;
  private _shadowDir: string;
  private _buildOptions: InternalBuildOptions = {
    entries: {},
  };

  private _extras: TBuildExtras | undefined = undefined;

  private _loopBuild() {
    this._nBuildRequests = 0;
    this._isBuilding = true;
    (async () => {
      try {
        const {
          entries,
          ...passthroughBuildOptions
        } = this._buildOptions;
        const extras = this._extras;
        const buildResult = await this._doBuild({
          entries: { ...entries },
          ...passthroughBuildOptions,
        });
        this.emit('build-end', buildResult, extras!);
      } catch (error) {
        if (error instanceof Error) {
          this.emit('build-failed', {
            message: error.message,
            stack: error.stack,
          });
        } else {
          this.emit('build-failed', {
            message: String(error),
          });
        }
        logger.debug('Build failed: %o', error);
      }
    })().then(() => {
    }).catch((err) => {
      logger.error(err);
    }).finally(() => {
      this._isBuilding = false;
      if (this._nBuildRequests > 0) {
        this._loopBuild();
      }
    });
  }

  private async _doBuild(options: InternalBuildOptions): Promise<BuildResult> {
    const entries = options.entries;
    if (Object.keys(entries).length === 0) {
      logger.debug('No entry found, skip build');
      this._cache = undefined;
      return {
        inferredFiles: [],
      };
    }

    const mainPart = await this._buildShadowPart(options);
    await this._buildWrapperPart(options);

    return mainPart;
  }

  private async _buildShadowPart(options: InternalBuildOptions): Promise<BuildResult> {
    const {
      entries,
    } = options;

    const uuidMap: Record<string, string> = {};

    const ENTRY_MODULE_PREFIX = 'oms-entry\0';

    const rollupEntries: Record<string, string> = {};
    for (const key of Object.keys(entries)) {
      rollupEntries[key] = ENTRY_MODULE_PREFIX + key;
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
        uuidMap,
        decorators: true,
      }),

      {
        name: 'oms-builder-input',
        buildEnd: async (error) => {
          if (error) {
            let errorMessage = '';
            if (error instanceof Error && error.name === 'RollupError') {
              const rollupError = error as rollup.RollupError;
              errorMessage = rollupError.message;
            } else {
              errorMessage = error.message;
            }
            logger.debug('rollup build failed: %s', errorMessage);
            this.emit('build-failed', {
              message: errorMessage,
              stack: error.stack,
            });
          } else {
            logger.debug('Build succeeded');
          }
        },
      },
    ];

    const rollupBuild = await rollup.rollup({
      cache: this._cache,
      input: rollupEntries,
      external(source, importer, isResolved) {
        if (['cc', 'cc/env'].includes(source)) {
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
      dir: join(this._outDir, 'shadow'),
      format: 'systemjs',
      chunkFileNames: '_chunks/[name]-[hash].js',
      entryFileNames: '[name].js',
      sourcemap: true,
      plugins: outputPlugins,
    };

    await rollupBuild.write(outputOptions);

    return {
      inferredFiles: rollupBuild.watchFiles,
    };
  }

  private async _buildWrapperPart(options: InternalBuildOptions) {
    const {
      entries,
    } = options;

    const ENTRY_WRAPPER_PREFIX = 'oms-entry-wrapper\0';

    const rollupEntries: Record<string, string> = {};
    for (const key of Object.keys(entries)) {
      rollupEntries[key] = ENTRY_WRAPPER_PREFIX + key;
    }

    const renderEntryWrapper = this._renderEntryWrapper.bind(this);
    const inputPlugins: rollup.Plugin[] = [
      {
        name: 'oms:load-entry-modules',

        resolveId(id, parent, info) {
          if (info.isEntry && id.startsWith(ENTRY_WRAPPER_PREFIX)) {
            return id;
          }
          return undefined;
        },

        load(id) {
          if (id.startsWith(ENTRY_WRAPPER_PREFIX)) {
            const entryModule = id.slice(ENTRY_WRAPPER_PREFIX.length);
            return renderEntryWrapper({ entryModule: entryModule + '.js' });
          }
          return undefined;
        },
      },

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
        decorators: false,
      }),

      {
        name: 'oms-builder-input',
        buildEnd: async (error) => {
          if (error) {
            let errorMessage = '';
            if (error instanceof Error && error.name === 'RollupError') {
              const rollupError = error as rollup.RollupError;
              errorMessage = rollupError.message;
            } else {
              errorMessage = error.message;
            }
            logger.debug('rollup build failed: %s', errorMessage);
            this.emit('build-failed', {
              message: errorMessage,
              stack: error.stack,
            });
          } else {
            logger.debug('Build wrapper part succeeded');
          }
        },
      },
    ];

    const rollupBuild = await rollup.rollup({
      input: rollupEntries,
      external(source) {
        if (['cc', 'cc/env'].includes(source)) {
          return true;
        }
        return false;
      },
      plugins: inputPlugins,
    });

    const outputPlugins: rollup.Plugin[] = [
    ];

    const outputOptions: rollup.OutputOptions = {
      dir: this._outDir,
      format: 'es',
      chunkFileNames: '_proxy-chunks/[name]-[hash].js',
      entryFileNames: '[name].js',
      sourcemap: true,
      plugins: outputPlugins,
    };

    await rollupBuild.write(outputOptions);
  }

  private _makeRollupBabelPlugin({
    uuidMap,
    decorators,
  }: {
    uuidMap?: Record<string, string>;
    decorators?: boolean;
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
        uuidMap
          ? [transformCCComponent({
            uuidMap,
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
        } satisfies babelPresetEnv.Options],
        [babelPresetTypescript, {

        }],
      ],
    });
  }

  private async _renderEntryWrapper(opts: {
    entryModule: string;
  }) {
    const loaderModule = resolve(import.meta.dirname, '../injections/loader.ts');
    let source = '';
    source += dedent`
    import { load } from '${makeAbsoluteImportSpecifier(loaderModule)}';;
    await load('shadow/${opts.entryModule}');\n
    export {};\n
    `;
    return source;
  }
}
