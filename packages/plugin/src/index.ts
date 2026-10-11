import type { FunctionPluginHooks, PluginContext } from 'rollup';

/** Native Rollup operations needed by source loaders. */
export interface OmsPluginContext extends Pick<PluginContext, 'addWatchFile' | 'error'
  | 'resolve'> {
  cache: Pick<PluginContext['cache'], 'get' | 'set'>;
}

type BuildHooks = {
  [K in 'buildStart' | 'resolveId' | 'load']?: (
    this: OmsPluginContext,
    ...args: Parameters<FunctionPluginHooks[K]>
  ) => ReturnType<FunctionPluginHooks[K]> | Promise<ReturnType<FunctionPluginHooks[K]>>;
};

/** Vite-compatible source-loader subset, executed by Rollup without result translation. */
export interface OmsPlugin extends BuildHooks {
  name: string;
  enforce?: 'pre';
}

/** Existing OMS host configuration, separate from the plugin contract. */
export interface OmsUserConfig {
  plugins?: OmsPlugin[];
  resolve?: {
    alias?: Record<string, string>;
    projectPeers?: readonly string[];
  };
  define?: Record<string, unknown>;
  mode?: string;
  envDir?: string;
  envPrefix?: string | readonly string[];
  profiles?: {
    default?: {
      exclude?: readonly string[];
    };
    headless?: {
      include?: readonly string[];
      exclude?: readonly string[];
      build?: {
        target?: string;
      };
    };
  };
}

type OmsUserConfigExport = OmsUserConfig | ((context: { mode: string }) => OmsUserConfig
  | Promise<OmsUserConfig>);

/** Type inference helper; returns the original configuration without wrapping it. */
export function defineConfig<T extends OmsUserConfigExport>(config: T): T {
  return config;
}
