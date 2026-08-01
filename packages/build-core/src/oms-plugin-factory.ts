import type * as rollup from 'rollup';
import rollupPluginCommonJS_ from '@rollup/plugin-commonjs';
import rollupPluginNodeResolve_ from '@rollup/plugin-node-resolve';
import rollupPluginBabel_ from '@rollup/plugin-babel';
import rollupPluginJson_ from '@rollup/plugin-json';
import rollupPluginAlias from '@rollup/plugin-alias';
import babelPresetEnv, { type TargetsOptions } from '@babel/preset-env';
// @ts-expect-error
import babelPluginProposalDecorators from '@babel/plugin-proposal-decorators';
// @ts-expect-error
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

const rollupPluginCommonJS = rollupPluginCommonJS_ as unknown as typeof rollupPluginCommonJS_.default;
const rollupPluginNodeResolve = rollupPluginNodeResolve_ as unknown as typeof rollupPluginNodeResolve_.default;
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
  projectRoot: string | undefined;
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

  return [
    rollupPluginDomain({
      domains: options.domains,
      allowEditorOnlyImports: options.allowEditorOnlyImports,
    }),

    rollupPluginWasm({}),

    rollupPluginNodeBuiltinModules({
      supportsNativeModules: options.supportsNativeModules,
    }),

    rollupPluginJson({
      namedExports: false,
    }),

    rollupPluginCommonJS({
      extensions: omsRuntimeCommonJsExtensions,
    }),

    rollupPluginAlias({
      entries: options.config.resolve.alias,
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

    rollupPluginDefine({
      define: options.projectDefine.define,
      watchFiles: options.projectDefine.watchFiles,
      sourcemap: options.sourcemap,
    }),
  ];
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
    extensions: omsRuntimeModuleExtensions,
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
