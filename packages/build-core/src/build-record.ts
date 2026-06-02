import * as rollup from 'rollup';
import rollupPluginCommonJS_ from '@rollup/plugin-commonjs';
import rollupPluginNodeResolve_ from '@rollup/plugin-node-resolve';
import rollupPluginBabel_ from '@rollup/plugin-babel';
import rollupPluginJson_ from '@rollup/plugin-json';
// @ts-expect-error
import babelPluginProposalDecorators from '@babel/plugin-proposal-decorators';
import babelPresetEnv, { type TargetsOptions } from '@babel/preset-env';
// @ts-expect-error
import babelPresetTypescript from '@babel/preset-typescript';
import { transformCCComponent, type UUIDProvider } from './features/babel-plugin-cc-component.js';
import { rollupPluginWasm } from './features/rollup-plugin-wasm.js';
import { rollupPluginMemoryModules } from './features/rollup-plugin-memory-modules.js';
import { generateCCEnvModuleSource, type CCEnvParams } from './features/generate-cc-env.js';
import { rollupPluginDomain } from './features/rollup-plugin-domain.js';
import { rollupPluginNodeBuiltinModules } from './features/rollup-plugin-node-builtin-modules.js';
import rollupPluginAlias from '@rollup/plugin-alias';
import type { OmsProjectConfig, ProfileBuildConfig } from './config.js';
import { logger } from './logger.js';
import type { Domain } from './domain.js';
import { join } from 'node:path';
import { makeOmsEntryFileName } from './utils/entry-id.js';
import { makeFileSystemAbsoluteImportSpecifier } from './utils/import-specifier.js';
import { rollupPluginProjectPeerImports } from './features/rollup-plugin-project-peer-imports.js';

const rollupPluginCommonJS = rollupPluginCommonJS_ as unknown as typeof rollupPluginCommonJS_.default;
const rollupPluginNodeResolve = rollupPluginNodeResolve_ as unknown as typeof rollupPluginNodeResolve_.default;
const rollupPluginBabel = rollupPluginBabel_ as unknown as typeof rollupPluginBabel_.default;
const rollupPluginJson = rollupPluginJson_ as unknown as typeof rollupPluginJson_.default;

export type InternalBuildEntry = string | {
  module: string;
};

export interface InternalBuildOptions {
  entries: Record<string, InternalBuildEntry>;
  domains: Record<string, Domain>;
  projectRoot?: string;
  uuidProvider: UUIDProvider | undefined;
  config: OmsProjectConfig;
  profileBuildConfig: ProfileBuildConfig | undefined;
}

export type InternalBuildResult = {
  ok: true;
  inferredFiles: string[];
} | {
  ok: false;
  error: {
    message: string;
    stack: string | undefined;
  };
};

export function mergeBuildResults(a: InternalBuildResult, b: InternalBuildResult): InternalBuildResult {
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
    title: string;
    outDir: string;
    sourceMaps?: boolean | 'inline';
    debug?: boolean;
    ccEnvParams?: CCEnvParams;
    config: OmsProjectConfig;
    headless: boolean;
    treeShake?: boolean;
  }) {
    this._title = options.title;
    this._outDir = options.outDir;
    this._headless = options.headless;
    this._sourceMaps = options.sourceMaps ?? true;
    this._debug = options.debug ?? true;
    this._ccEnvParams = options.ccEnvParams;
    this._treeShake = options.treeShake ?? true;
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
    try {
      const {
        entries,
        ...passthroughBuildOptions
      } = this._buildOptions;
      const buildResult = await this._doBuild({
        entries: { ...entries },
        ...passthroughBuildOptions,
      });
      return buildResult;
    } catch (error) {
      logger.debug(`${this._title} Build failed: %o`, error);
      return buildFailureResult(this._title, error);
    }
  }

  private _title: string;
  private _cache: rollup.RollupCache | undefined;
  private _outDir: string;
  private _headless: boolean;
  private _sourceMaps: boolean | 'inline';
  private _debug: boolean;
  private _treeShake: boolean;
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
      return {
        ok: true,
        inferredFiles: [],
      };
    }

    const mainPart = await this._doBuildUnchecked(options);
    return mainPart;
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

    const uuidProvider = options.uuidProvider;
    const inputPlugins: (rollup.Plugin | undefined)[] = [
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
            logger.debug(`UUID of ${options.id} changed from ${previousUUID} to ${uuid}, invalidate its cache`);
            this.cache.set(cacheKey, uuid);
            return true;
          }
          return undefined;
        },
      },

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

      rollupPluginDomain({
        domains: options.domains,
      }),

      rollupPluginWasm({}),

      rollupPluginNodeBuiltinModules({
        supportsNativeModules: !!this._headless,
      }),

      rollupPluginJson({
        namedExports: false,
      }),

      rollupPluginCommonJS({
        extensions: [
          '.js',
          '.cjs',
        ],
      }),

      rollupPluginAlias({
        entries: this._buildOptions.config.resolve.alias,
      }),

      rollupPluginProjectPeerImports({
        projectPeers: this._buildOptions.config.resolve.projectPeers,
        projectRoot: options.projectRoot,
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
        exportConditions: [this._headless ? 'headless' : undefined].filter((condition) => condition !== undefined),
      }),

      this._makeRollupBabelPlugin({
        uuidProvider: options.uuidProvider,
        decorators: true,
      }),

      {
        name: 'oms:perf-watch',

        transform: (code, id) => {
          logger.debug(`Transforming ${id}`);
        },
      },
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
      perf: true,
      treeshake: this._treeShake,
    });

    this._cache = rollupBuild.cache;

    const outputPlugins: rollup.Plugin[] = [
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

    await rollupBuild.write(outputOptions);
    if (rollupBuild.getTimings) {
      logger.debug(`${this._title} Rollup timings: %o`, rollupBuild.getTimings());
    }

    return {
      ok: true,
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
    const babelTarget = toBabelEnvTarget(this._buildOptions.profileBuildConfig?.target);
    logger.debug(`Babel target: ${JSON.stringify(babelTarget)}`);
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
          targets: babelTarget,
          include: [
            decorators ? '@babel/plugin-transform-class-properties' : undefined,
            '@babel/plugin-transform-class-static-block',
          ].filter((p): p is string => !!p),
        } satisfies babelPresetEnv.Options],
        [babelPresetTypescript, {
          allowDeclareFields: true,
        }],
      ],
    });
  }
}

const ROLLUP_MODULE_CACHE_KEY_UUID = '__oms_uuid__';

function toBabelEnvTarget(target: string | undefined): TargetsOptions {
  if (!target) {
    return {
      node: '14',
    };
  }
  const match = /(\w+)(\d.+)/.exec(target);
  if (!match) {
    return target;
  }
  const [_, runtime, version] = match;
  return {
    [runtime]: version,
  };
}

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
    error.stack || error.message || error.name,
  ];
  const cause = error.cause;
  if (cause) {
    const causeStacks = collectErrorStacks(cause);
    parts.push(...(causeStacks.length > 0 ? causeStacks : [errorToBuildMessage(cause)]));
  }
  return parts;
}
