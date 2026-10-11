import type * as rollup from 'rollup';
import { join } from 'node:path';
import rollupPluginCommonJS_ from '@rollup/plugin-commonjs';
import rollupPluginNodeResolve_ from '@rollup/plugin-node-resolve';
import rollupPluginBabel_ from '@rollup/plugin-babel';
import rollupPluginJson_ from '@rollup/plugin-json';
import rollupPluginAlias from '@rollup/plugin-alias';
import babelPresetEnv, { type TargetsOptions } from '@babel/preset-env';
// @ts-expect-error Babel's published CJS package does not provide a declaration entry.
import babelPluginProposalDecorators from '@babel/plugin-proposal-decorators';
// @ts-expect-error Babel's published CJS package does not provide a declaration entry.
import babelPresetTypescript from '@babel/preset-typescript';
import { transformCCComponent, type UUIDProvider } from './features/babel-plugin-cc-component.js';
import { rollupPluginDefine } from './features/rollup-plugin-define.js';
import { rollupPluginDomain } from './features/rollup-plugin-domain.js';
import { rollupPluginNodeBuiltinModules } from './features/rollup-plugin-node-builtin-modules.js';
import { rollupPluginProjectPeerImports } from './features/rollup-plugin-project-peer-imports.js';
import { rollupPluginWasm } from './features/rollup-plugin-wasm.js';
import type { OmsProjectConfig } from './config.js';
import type { Domain } from './domain.js';
import type { ProjectDefineResult } from './env.js';
import { logger } from './logger.js';
import type { OmsPlugin, OmsPluginContext } from '@oms/plugin';
import { rollupPluginAssetUUID } from './features/rollup-plugin-asset-uuid.js';

const rollupPluginCommonJS
  = rollupPluginCommonJS_ as unknown as typeof rollupPluginCommonJS_.default;
const rollupPluginNodeResolve
  = rollupPluginNodeResolve_ as unknown as typeof rollupPluginNodeResolve_.default;
const rollupPluginBabel = rollupPluginBabel_ as unknown as typeof rollupPluginBabel_.default;
const rollupPluginJson = rollupPluginJson_ as unknown as typeof rollupPluginJson_.default;

const omsRuntimeModuleExtensions = [
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.mts',
  '.cts',
];

const omsRuntimeCommonJsExtensions = [
  '.js',
  '.cjs',
];

interface OmsRuntimePluginOptions {
  projectRoot: string;
  config: OmsProjectConfig;
  domains: Record<string, Domain>;
  allowEditorOnlyImports: boolean;
  projectDefine: ProjectDefineResult;
  uuidProvider: UUIDProvider | undefined;
  supportsNativeModules: boolean;
  nodeResolveExportConditions?: string[];
  target: string | undefined;
  sourcemap: boolean | 'inline';
  decorators?: boolean;
}

export function createOmsRuntimePlugins(options: OmsRuntimePluginOptions): rollup.Plugin[] {
  const nodeResolveOptions = {
    extensions: omsRuntimeModuleExtensions,
    allowExportsFolderMapping: false,
    preferBuiltins: false,
    ...(options.nodeResolveExportConditions
      ? {
        exportConditions: options.nodeResolveExportConditions,
      }
      : {}),
  };

  // Follow Vite's alias/pre/core/normal groups and preserve existing core plugin order.
  return [
    rollupPluginAlias({
      entries: options.config.resolve.alias,
    }),

    ...options.config.plugins.filter((plugin) => plugin.enforce === 'pre').map(adaptOmsPlugin),

    // Recognize the query before domain and format-specific resolvers see the specifier.
    rollupPluginAssetUUID({
      assetDirs: [join(options.projectRoot, 'assets')],
    }),

    rollupPluginDomain({
      domains: options.domains,
      allowEditorOnlyImports: options.allowEditorOnlyImports,
    }),

    rollupPluginWasm(),

    rollupPluginNodeBuiltinModules({
      supportsNativeModules: options.supportsNativeModules,
    }),

    rollupPluginJson({
      namedExports: false,
    }),

    rollupPluginCommonJS({
      extensions: omsRuntimeCommonJsExtensions,
    }),

    rollupPluginProjectPeerImports({
      projectPeers: options.config.resolve.projectPeers,
      projectRoot: options.projectRoot,
    }),

    rollupPluginNodeResolve(nodeResolveOptions),

    createOmsRuntimeBabelPlugin({
      uuidProvider: options.uuidProvider,
      decorators: options.decorators,
      babelTarget: toBabelEnvTarget(options.target),
    }),

    ...options.config.plugins.filter((plugin) => plugin.enforce === undefined).map(adaptOmsPlugin),

    rollupPluginDefine({
      define: options.projectDefine.define,
      watchFiles: options.projectDefine.watchFiles,
      sourcemap: options.sourcemap,
    }),
  ];
}

/** Narrow the public context while preserving native plugin identity and skipSelf. */
function adaptOmsPlugin(plugin: OmsPlugin): rollup.Plugin {
  const adapted: rollup.Plugin = {
    name: plugin.name,
  };
  for (const stage of ['buildStart', 'resolveId', 'load'] as const) {
    const hook = plugin[stage];
    if (!hook) {
      continue;
    }
    Object.assign(adapted, {
      [stage](this: rollup.PluginContext, ...args: unknown[]) {
        const context: OmsPluginContext = {
          addWatchFile: this.addWatchFile.bind(this),
          resolve: this.resolve.bind(this),
          error: this.error.bind(this),
          cache: {
            get: this.cache.get.bind(this.cache),
            set: this.cache.set.bind(this.cache),
          },
        };
        return Reflect.apply(hook, context, args);
      },
    });
  }
  return adapted;
}

function createOmsRuntimeBabelPlugin({
  uuidProvider,
  decorators,
  babelTarget,
}: {
  uuidProvider: UUIDProvider | undefined;
  decorators?: boolean;
  babelTarget: TargetsOptions;
}) {
  logger.debug(`Babel target: ${JSON.stringify(babelTarget)}`);
  return rollupPluginBabel({
    // An empty suffix matches every loaded module, including custom filenames.
    extensions: [''],
    // Babel's default filter excludes \0 virtual IDs; their JavaScript also needs target lowering.
    filter: () => true,
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
        ? [babelPluginProposalDecorators,
          {
            version: 'legacy',
          }]
        : undefined,
    ].filter((p) => !!p),
    presets: [
      [
        babelPresetEnv,
{
  modules: false,
  targets: babelTarget,
  include: [
    // Legacy decorators require class field lowering, which also requires private method/accessor
    // lowering.
    ...(decorators
      ? [
        '@babel/plugin-transform-class-properties',
        '@babel/plugin-transform-private-methods',
      ]
      : []),
    '@babel/plugin-transform-class-static-block',
  ],
} satisfies babelPresetEnv.Options,
      ],
      [babelPresetTypescript,
        {
          allowDeclareFields: true,
        }],
    ],
  });
}

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
