import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
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
import  * as chokidar from 'chokidar';
import EventEmitter from 'node:events';

const rollupPluginCommonJS = rollupPluginCommonJS_ as unknown as typeof rollupPluginCommonJS_.default;
const rollupPluginNodeResolve = rollupPluginNodeResolve_ as unknown as typeof rollupPluginNodeResolve_.default;
const rollupPluginBabel = rollupPluginBabel_ as unknown as typeof rollupPluginBabel_.default;

export class OmsBuilder {
  constructor(private _ctx: ServerContext, {
    project,
  }: {
    project: string;
  }) {
    this._projectPath = project;
    this._sourceRoot = join(this._projectPath, 'src');
  }

  async rebuild() {
    await this._rebuild();
  }

  private _projectPath: string;
  private _sourceRoot: string;
  private _buildRecord: BuildRecord | undefined;
  private _entries: string[] = [];
  private _watcher: chokidar.FSWatcher | undefined;

  private async _clean() {
    await this._buildRecord?.abort();
    this._buildRecord = undefined;
    if (this._watcher) {
      this._watcher.close();
      this._watcher = undefined;
    }
  }

  private async _rebuild() {
    await this._clean();

    const sourceRoot = this._sourceRoot;
    const outDir = resolve(this._projectPath, 'temp', 'oms', 'out');
    await fs.ensureDir(outDir);
    await fs.emptyDir(outDir);

    const buildRecord = new BuildRecord({
      sourceRoot: this._sourceRoot,
      outDir,
      shadowDir: resolve(this._projectPath, 'assets/shadow-source'),
    });

    const entries: string[] = [];
    const currentWatchedInferredFiles = new Set<string>();

    const buildWithEntryChanged = () => {
      buildRecord.rebuild({
        entries,
      });
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
        buildWithEntryChanged();
      })
      .on('error', (error) => {
        logger.error('Watcher error: %s', error);
      })
      .on('all', (event, path) => {
        logger.debug('Watcher event: %s, Path: %s', event, path);
      })
      .on('add', (path) => {
        if (path.startsWith(sourceRoot)) {
          entries.push(path);
          buildWithEntryChanged();
        }
      })
      .on('change', (path) => {
        buildRecord.requestBuild();
      })
      .on('unlink', (path) => {
        const index = entries.indexOf(path);
        if (index !== -1) {
          entries.splice(index, 1);
          buildWithEntryChanged();
        }
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
      this._ctx.ipc.invoke('build-failed', {});
    });

    buildRecord.on('build-end', (buildResult) => {
      nBuildEnds++;

      this._ctx.ipc.invoke('build-success', {
        affectedFiles: [...buildResult.affectedFiles],
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
}

function* readDirRecurse(root: string, current: string = ''): Generator<string> {
  const path = resolve(root, current);
  const stat = fs.statSync(path);
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(path)) {
      yield* readDirRecurse(root, join(current, entry));
    }
  } else {
    yield current;
  }
}

function makeImportSpecifier(from: string, to: string) {
  let path = relative(from, to).replace(/\\/g, '/');
  if (path.startsWith('./')) {
    path = './' + path;
  }
  return path;
}

interface InternalBuildOptions {
  entries: string[],
}

interface BuildResult {
  inferredFiles: string[];
  affectedFiles: string[];
}

class BuildRecord extends EventEmitter<{
  'build-start': [];
  'build-end': [BuildResult];
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

  rebuild(options: InternalBuildOptions) {
    Object.assign(this._buildOptions, options);
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
    entries: [],
  };

  private _loopBuild() {
    this._nBuildRequests = 0;
    this._isBuilding = true;
    (async () => {
      try {
        const {
          entries,
          ...passthroughBuildOptions
        } = this._buildOptions;
        const buildResult = await this._doBuild({
          entries: [...entries],
          ...passthroughBuildOptions,
        });
        this.emit('build-end', buildResult);
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
    }).finally(() => {
      this._isBuilding = false;
      if (this._nBuildRequests > 0) {
        this._loopBuild();
      }
    });
  }

  private async _doBuild(options: InternalBuildOptions): Promise<BuildResult> {
    const {
      entries,
    } = options;

    if (entries.length === 0) {
      logger.debug('No entry found, skip build');
      this._cache = undefined;
      return {
        inferredFiles: [],
        affectedFiles: [],
      };
    }

    const affectedFiles: string[] = [];

    const babel = rollupPluginBabel({
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
          [babelPluginProposalDecorators, {
            version: 'legacy',
          }],
        ],
        presets: [
          [babelPresetEnv, {
            modules: false,
            targets: {
              node: '14',
            },
          } satisfies babelPresetEnv.Options],
        ],
      });

    const inputPlugins: rollup.Plugin[] = [
      rollupPluginCommonJS({
        extensions: [
          '.js',
          '.mjs',
          '.cjs',
          '.ts',
          '.mts',
          '.cts',
        ],
      }),

      rollupPluginNodeResolve(),

      babel,

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
      input: entries,
      external(source, importer, isResolved) {
        if (['cc', 'cc/env'].includes(source)) {
          return true;
        }
        return false;
      },
      plugins: inputPlugins,
    });

    // this._cache = rollupBuild.cache;

    const outputPlugins: rollup.Plugin[] = [
      this._makePluginOmsBuilder(affectedFiles),
    ];

    const outputOptions: rollup.OutputOptions = {
      dir: this._outDir,
      format: 'es',
      chunkFileNames: '_chunks/[name]-[hash].mjs',
      entryFileNames: '[name].mjs',
      sourcemap: true,
      plugins: outputPlugins,
    };

    await rollupBuild.write(outputOptions);

    return {
      inferredFiles: rollupBuild.watchFiles,
      affectedFiles,
    };
  }

  private _makePluginOmsBuilder(affectedFiles: string[]): rollup.Plugin {
    const sourceRoot = this._sourceRoot;
    const outDir = this._outDir;
    const shadowDir = this._shadowDir;

    return {
      name: 'oms-builder',

      async writeBundle(options, bundle) {
        for (const [name, chunk] of Object.entries(bundle)) {
          if (chunk.type === 'chunk') {
            if (chunk.isEntry && !chunk.isImplicitEntry) {
              if (!chunk.facadeModuleId) {
                continue;
              }
              const relativePath = relative(sourceRoot, chunk.facadeModuleId);
              if (isAbsolute(relativePath) || relativePath.startsWith('..')) {
                this.warn(`Entry bundle ${name} is not under source root ${sourceRoot}, skip it`);
              } else {
                const shadowPath = resolve(shadowDir, relativePath);
                fs.ensureDirSync(dirname(shadowPath));
                const chunkFinalPath = resolve(outDir, chunk.fileName);
                const specifierToChunk = makeImportSpecifier(dirname(shadowPath), chunkFinalPath);
                await fs.writeFile(shadowPath, `
                    /// This is shadow file generated from ${chunk.fileName}
                    export * from '${specifierToChunk}';
                    `, 'utf8');
                affectedFiles.push(shadowPath);
              }
            }
          }
        }
      },
    };
  }
}
