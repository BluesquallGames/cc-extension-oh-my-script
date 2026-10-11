import * as rollup from 'rollup';
import type { UUIDProvider } from './features/babel-plugin-cc-component.js';
import { rollupPluginMemoryModules } from './features/rollup-plugin-memory-modules.js';
import { generateCCEnvModuleSource, type CCEnvParams } from './features/generate-cc-env.js';
import type { OmsProjectConfig, ProfileBuildConfig } from './config.js';
import { logger } from './logger.js';
import type { Domain } from './domain.js';
import { join, resolve } from 'node:path';
import fs from 'fs-extra';
import { makeOmsEntryFileName } from './utils/entry-id.js';
import { makeFileSystemAbsoluteImportSpecifier } from './utils/import-specifier.js';
import { createProjectDefine } from './env.js';
import { rollupPluginMinify } from './features/rollup-plugin-minify.js';
import { createOmsRuntimePlugins } from './oms-plugin-factory.js';

export type InternalBuildEntry = string | {
  module: string;
};

export interface InternalBuildOptions {
  entries: Record<string, InternalBuildEntry>;
  domains: Record<string, Domain>;
  uuidProvider: UUIDProvider | undefined;
  config: OmsProjectConfig;
  profileBuildConfig: ProfileBuildConfig | undefined;
}

export type InternalBuildResult = {
  ok: true;
  inferredFiles: string[];
} | {
  ok: false;
  inferredFiles?: string[];
  error: {
    message: string;
    stack: string | undefined;
  };
};

export function mergeBuildResults(a: InternalBuildResult, b: InternalBuildResult):
InternalBuildResult {
  if (a.ok && b.ok) {
    return {
      ok: true,
      inferredFiles: [...a.inferredFiles, ...b.inferredFiles],
    };
  }
  if (!a.ok && !b.ok) {
    return {
      ok: false,
      error: {
        message: a.error.message + '\n' + b.error.message,
        stack: undefined,
      },
    };
  }

  if (!a.ok) {
    return a;
  }

  return b;
}

export class BuildRecord {
  constructor(options: {
    projectRoot: string;
    title: string;
    outDir: string;
    sourceMaps?: boolean | 'inline';
    minify?: boolean;
    ccEnvParams?: CCEnvParams;
    config: OmsProjectConfig;
    headless: boolean;
    treeShake?: boolean;
    mode?: string;
  }) {
    this._projectRoot = options.projectRoot;
    this._title = options.title;
    this._outDir = options.outDir;
    this._headless = options.headless;
    this._sourceMaps = options.sourceMaps ?? true;
    this._minify = options.minify ?? false;
    this._ccEnvParams = options.ccEnvParams;
    this._treeShake = options.treeShake ?? true;
    this._mode = options.mode;
    this._buildOptions = {
      entries: {},
      uuidProvider: undefined,
      domains: {},
      config: options.config,
      profileBuildConfig: undefined,
    };
  }

  async rebuild(options: InternalBuildOptions) {
    Object.assign(this._buildOptions, options);
    return await this.build();
  }

  async build(): Promise<InternalBuildResult> {
    logger.debug(`${this._title} Build with options: %o`, this._buildOptions);
    let result: InternalBuildResult;
    try {
      if (this._cacheConfig !== this._buildOptions.config) {
        this._cache = undefined;
        this._cacheConfig = this._buildOptions.config;
      }
      const {
        entries,
        ...passthroughBuildOptions
      } = this._buildOptions;
      result = await this._doBuild({
        entries: { ...entries },
        ...passthroughBuildOptions,
      });
    } catch (error) {
      logger.debug(`${this._title} Build failed: %o`, error);
      result = {
        ...buildFailureResult(this._title, error),
        inferredFiles: error && typeof error === 'object' && 'watchFiles' in error
          && Array.isArray(error.watchFiles)
          ? error.watchFiles
          : [],
      };
    }
    // Rollup preserves addWatchFile() paths verbatim, including relative paths and mixed
    // separators.
    // Normalize at the Rollup-to-OMS boundary so inferredFiles contain absolute native paths.
    return {
      ...result,
      inferredFiles: (result.inferredFiles ?? []).map((file) => resolve(file)),
    };
  }

  private readonly _projectRoot: string;
  private _title: string;
  private _cache: rollup.RollupCache | undefined;
  private _cacheConfig: OmsProjectConfig | undefined;
  private _emittedFiles = new Set<string>();
  private _outDir: string;
  private _headless: boolean;
  private _sourceMaps: boolean | 'inline';
  private _minify: boolean;
  private _treeShake: boolean;
  private _mode: string | undefined;
  private _suppressRollupWarningCodes = [
    'CIRCULAR_DEPENDENCY',
    'THIS_IS_UNDEFINED',
    'UNUSED_EXTERNAL_IMPORT',
  ];

  private _ccEnvParams: CCEnvParams | undefined;
  private _buildOptions: InternalBuildOptions;

  private async _doBuild(options: InternalBuildOptions): Promise<InternalBuildResult> {
    const entries = options.entries;
    if (Object.keys(entries).length === 0) {
      logger.debug(`${this._title} No entry found, skip build`);
      this._cache = undefined;
      await this._reconcileEmittedFiles(new Set());
      return { ok: true, inferredFiles: [] };
    }

    return await this._doBuildUnchecked(options);
  }

  private async _doBuildUnchecked(options: InternalBuildOptions): Promise<InternalBuildResult> {
    const {
      entries,
    } = options;

    const ENTRY_MODULE_PREFIX = 'oms-entry\0';

    const rollupEntries: Record<string, string> = {};
    const memoryEntryModules: Record<string, string> = {};
    for (const key of Object.keys(entries)) {
      const rollupEntryName = makeOmsEntryFileName(key);
      if (rollupEntryName in rollupEntries) {
        logger.warn(`Duplicate entry file name ${rollupEntryName} for entry ${key}`);
        continue;
      }
      const entry = entries[key];
      if (typeof entry === 'string') {
        rollupEntries[rollupEntryName] = ENTRY_MODULE_PREFIX + key;
        memoryEntryModules[key] = entry;
      } else {
        rollupEntries[rollupEntryName] = makeFileSystemAbsoluteImportSpecifier(entry.module);
      }
    }

    const memoryModules: Record<string, string> = {};
    const externals: string[] = [
      'cc',
    ];

    if (this._ccEnvParams) {
      const ccEnvMouseSource = memoryModules['cc/env'] = generateCCEnvModuleSource({
        params: this._ccEnvParams,
      });
      logger.debug(`${this._title} "cc/env" source: %s`, ccEnvMouseSource);
    } else {
      externals.push('cc/env');
    }

    const projectDefine = await createProjectDefine({
      config: options.config,
      projectRoot: this._projectRoot,
      mode: this._mode,
    });
    const projectDefineSignature = JSON.stringify(projectDefine.define);

    const uuidProvider = options.uuidProvider;
    const inputPlugins: Array<rollup.Plugin | undefined> = [
      {
        name: 'oms:uuid',

        shouldTransformCachedModule(options) {
          if (!uuidProvider) {
            return undefined;
          }
          const cacheKey = ROLLUP_MODULE_CACHE_KEY_UUID + ':' + options.id;
          const uuid = uuidProvider(options.id);
          const previousUUID = this.cache.get(cacheKey);
          if (uuid !== previousUUID) {
            logger.debug(`UUID of ${options
              .id} changed from ${previousUUID} to ${uuid}, invalidate its cache`);
            this.cache.set(cacheKey, uuid);
            return true;
          }
          return undefined;
        },
      },

      {
        name: 'oms:define-cache',

        shouldTransformCachedModule(options) {
          const cacheKey = ROLLUP_MODULE_CACHE_KEY_DEFINE + ':' + options.id;
          const previousSignature = this.cache.get(cacheKey);
          if (previousSignature !== projectDefineSignature) {
            this.cache.set(cacheKey, projectDefineSignature);
            return true;
          }
          return undefined;
        },
      },

      {
        name: 'oms:load-entry-modules',

        resolveId(id, _parent, info) {
          if (info.isEntry && id.startsWith(ENTRY_MODULE_PREFIX)) {
            return id;
          }
          return undefined;
        },

        load(id) {
          if (id.startsWith(ENTRY_MODULE_PREFIX)) {
            const entryModuleId = id.slice(ENTRY_MODULE_PREFIX.length);
            const entryModuleSource = memoryEntryModules[entryModuleId];
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

      ...createOmsRuntimePlugins({
        projectRoot: this._projectRoot,
        config: options.config,
        domains: options.domains,
        allowEditorOnlyImports: this._mode !== 'production',
        projectDefine,
        uuidProvider: options.uuidProvider,
        supportsNativeModules: !!this._headless,
        nodeResolveExportConditions: [this._headless ? 'headless' : undefined].filter((
          condition): condition is string => condition !== undefined),
        target: this._buildOptions.profileBuildConfig?.target,
        sourcemap: this._sourceMaps,
        decorators: true,
      }),

      {
        name: 'oms:perf-watch',

        transform: (_code, id) => {
          logger.debug(`Transforming ${id}`);
        },
      },
    ];

    const rollupStart = Date.now();
    const rollupBuild = await rollup.rollup({
      cache: this._cache,
      input: rollupEntries,
      external(source, _importer, _isResolved) {
        if (externals.includes(source)) {
          return true;
        }
        return false;
      },
      plugins: inputPlugins,
      onwarn: (warning) => {
        if (warning.code && this._suppressRollupWarningCodes.includes(warning.code)) {
          return;
        }
        const message = warning.message;
        if (warning.code === 'SOURCEMAP_ERROR') {
          logger.debug(`${this._title} Rollup warning [${warning.code}]: ${message}`);
          return;
        }
        logger.warn(`${this._title} Rollup warning${warning.plugin
          ? ` (${warning
            .plugin})`
          : ''}${warning.code ? ` [${warning.code}]` : ''}: ${message}`);
      },
      perf: true,
      treeshake: this._treeShake,
    });
    try {
      logger.info(`${this._title} Rollup build done in ${Date.now() - rollupStart}ms`);

      const outputPlugins: rollup.Plugin[] = [
        ...(this._minify ? [rollupPluginMinify()] : []),
      ];

      const preserveModules = !!this._headless;
      const outputOptions: rollup.OutputOptions = {
        dir: join(this._outDir),
        format: this._headless ? 'es' : 'systemjs',
        entryFileNames: (chunkInfo) => `${makeOmsEntryFileName(chunkInfo.name)}.js`,
        chunkFileNames: '_chunks/[name]-[hash].js',
        assetFileNames: '_assets/[name]-[hash][extname]',
        sourcemap: this._sourceMaps,
        plugins: outputPlugins,
        // onlyExplicitManualChunks: true,
        manualChunks: preserveModules
          ? undefined
          : (id, _meta) => {
            if (id === 'cc/env') {
              return 'cc-env';
            }
            return null;
          },
        preserveModules: !!this._headless,
      };

      const writeStart = Date.now();
      const writeResult = await rollupBuild.write(outputOptions);
      const emittedFiles = new Set(writeResult.output.map((output) => output.fileName));
      await this._reconcileEmittedFiles(emittedFiles);
      const outputSummary = await summarizeOutputDir(this._outDir);
      logger.info(`${this._title} Rollup write done in ${Date.now(
      ) - writeStart}ms (${outputSummary.files} files, ${formatBytes(outputSummary.bytes)})`);
      if (rollupBuild.getTimings) {
        logger.debug(`${this._title} Rollup timings: %o`, rollupBuild.getTimings());
      }
      this._cache = rollupBuild.cache;
      return { ok: true, inferredFiles: rollupBuild.watchFiles };
    } catch (error) {
      logger.debug(`${this._title} Build failed: %o`, error);
      return { ...buildFailureResult(this._title, error), inferredFiles: rollupBuild.watchFiles };
    } finally {
      await rollupBuild.close();
    }
  }

  private async _reconcileEmittedFiles(emittedFiles: Set<string>) {
    await Promise.all([...this._emittedFiles]
      .filter((file) => !emittedFiles.has(file))
      .map((file) => fs.remove(join(this._outDir, file))));
    this._emittedFiles = emittedFiles;
  }
}

async function summarizeOutputDir(dir: string) {
  let files = 0;
  let bytes = 0;
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      const childSummary = await summarizeOutputDir(path);
      files += childSummary.files;
      bytes += childSummary.bytes;
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    files += 1;
    bytes += (await fs.stat(path)).size;
  }
  return {
    files,
    bytes,
  };
}

function formatBytes(bytes: number) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

const ROLLUP_MODULE_CACHE_KEY_UUID = '__oms_uuid__';
const ROLLUP_MODULE_CACHE_KEY_DEFINE = '__oms_define__';

function buildFailureResult(title: string, error: unknown): InternalBuildResult {
  const message = errorToBuildMessage(error);
  return {
    ok: false,
    error: {
      message: `${title} failed: ${message}`,
      stack: errorToBuildStack(error),
    },
  };
}

function errorToBuildMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name;
  }
  if (typeof error === 'string') {
    return error;
  }
  if (typeof error === 'symbol') {
    return `Symbol [${error.description}]`;
  }
  if (typeof error === 'bigint') {
    return `BigInt [${error}]`;
  }
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return 'unknown build error';
  }
}

function errorToBuildStack(error: unknown): string | undefined {
  const stackParts = collectErrorStacks(error);
  if (stackParts.length === 0) {
    return undefined;
  }
  return stackParts.join('\nCaused by: ');
}

function collectErrorStacks(error: unknown): string[] {
  if (!(error instanceof Error)) {
    return [];
  }
  const parts = [
    error.stack?.length ? error.stack : error.message.length ? error.message : error.name,
  ];
  const cause = error.cause;
  if (cause) {
    const causeStacks = collectErrorStacks(cause);
    parts.push(...(causeStacks.length > 0 ? causeStacks : [errorToBuildMessage(cause)]));
  }
  return parts;
}
