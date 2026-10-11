import { platform } from 'node:process';
import picomatch from 'picomatch';
import { logger } from './logger.js';
import { getBarePackageName } from './utils/package-name.js';
import type { OmsPlugin } from '@oms/plugin';

export interface OmsConfigContext {
  mode: string;
}

export interface OmsProjectUserConfig {
  plugins?: readonly OmsPlugin[];
  resolve?: {
    alias?: Record<string, string>;
    projectPeers?: readonly string[];
  };

  define?: Record<string, unknown>;
  mode?: string;
  envDir?: string;
  envPrefix?: string | readonly unknown[];

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

export interface OmsProjectConfig {
  plugins: readonly OmsPlugin[];
  resolve: {
    alias?: Record<string, string>;
    projectPeers: string[];
  };

  define: Record<string, string>;
  mode: string;
  envDir: string | undefined;
  envPrefix: string[];

  profiles: ProjectProfilesConfig;
}

export interface ProjectProfilesConfig {
  default: ProfileConfig;
  headless: ProfileConfig | undefined;
}

export interface ProfileConfig {
  include?: (string: string) => boolean;
  exclude?: (string: string) => boolean;
  build: ProfileBuildConfig;
}

export interface ProfileBuildConfig {
  target: string | undefined;
}

export function normalizeProjectUserConfig(userConfig: OmsProjectUserConfig): OmsProjectConfig {
  const plugins = [...(userConfig.plugins ?? [])];
  const supported = new Set([
    'name',
    'enforce',
    'buildStart',
    'resolveId',
    'load',
  ]);
  for (const plugin of plugins) {
    if (!plugin.name) {
      throw new Error('OMS plugin name must be non-empty');
    }
    for (const key of Object.keys(plugin)) {
      if (!supported.has(key)) {
        throw new Error(`OMS plugin ${plugin.name}: unsupported plugin option ${key}`);
      }
    }
    if (plugin.enforce !== undefined && plugin.enforce !== 'pre') {
      throw new Error(`OMS plugin ${plugin.name}: invalid enforce value`);
    }
    for (const hook of ['buildStart', 'resolveId', 'load'] as const) {
      if (plugin[hook] !== undefined && typeof plugin[hook] !== 'function') {
        throw new Error(`OMS plugin ${plugin.name}: ${hook} must be a function`);
      }
    }
  }
  plugins.sort((a, b) => Number(b.enforce === 'pre') - Number(a.enforce === 'pre'));
  return {
    plugins,
    resolve: userConfig.resolve
      ? {
        alias: userConfig.resolve.alias,
        projectPeers: normalizeProjectPeers(userConfig.resolve.projectPeers),
      }
      : {
        alias: undefined,
        projectPeers: [],
      },

    define: normalizeDefine(userConfig.define),
    mode: normalizeMode(userConfig.mode),
    envDir: normalizeEnvDir(userConfig.envDir),
    envPrefix: normalizeEnvPrefix(userConfig.envPrefix),
    profiles: normalizeUserProfilesConfig(userConfig.profiles),
  };
}

function normalizeDefine(define: unknown) {
  if (define === undefined) {
    return {};
  }
  if (!define || typeof define !== 'object' || Array.isArray(define)) {
    logger.error('define should be an object');
    return {};
  }
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(define)) {
    if (!key) {
      logger.error('define entries should have non-empty keys');
      continue;
    }
    if (value === undefined) {
      normalized[key] = 'undefined';
      continue;
    }
    if (typeof value === 'string') {
      normalized[key] = value;
      continue;
    }
    const expression = JSON.stringify(value);
    if (expression === undefined) {
      logger.error(
        `define entry ${key} should be JSON serializable or a JavaScript expression string`);
      continue;
    }
    normalized[key] = expression;
  }
  return normalized;
}

function normalizeMode(mode: unknown) {
  if (mode === undefined) {
    return 'development';
  }
  if (typeof mode !== 'string' || mode.length === 0) {
    logger.error('mode should be a non-empty string');
    return 'development';
  }
  return mode;
}

function normalizeEnvDir(envDir: unknown) {
  if (envDir === undefined) {
    return undefined;
  }
  if (typeof envDir !== 'string' || envDir.length === 0) {
    logger.error('envDir should be a non-empty string');
    return undefined;
  }
  return envDir;
}

function normalizeEnvPrefix(envPrefix: unknown) {
  if (envPrefix === undefined) {
    return ['OMS_'];
  }
  const prefixes = Array.isArray(envPrefix) ? envPrefix : [envPrefix];
  const normalized = new Set<string>();
  for (const prefix of prefixes) {
    if (typeof prefix !== 'string' || prefix.length === 0) {
      logger.error('envPrefix entries should be non-empty strings');
      continue;
    }
    normalized.add(prefix);
  }
  if (normalized.size === 0) {
    logger.error('envPrefix should include at least one non-empty string');
    return ['OMS_'];
  }
  return [...normalized];
}

function normalizeProjectPeers(projectPeers: unknown) {
  if (projectPeers === undefined) {
    return [];
  }
  if (!Array.isArray(projectPeers)) {
    logger.error('resolve.projectPeers should be an array of package names');
    return [];
  }

  const normalized = new Set<string>();
  for (const peer of projectPeers) {
    if (typeof peer !== 'string' || peer.length === 0) {
      logger.error('resolve.projectPeers entries should be non-empty package names');
      continue;
    }
    const packageName = getBarePackageName(peer);
    if (packageName !== peer) {
      logger.error(`resolve.projectPeers entry ${peer} should be a bare package name`);
      continue;
    }
    normalized.add(packageName);
  }
  return [...normalized];
}

export type OmsUserConfig = OmsProjectUserConfig;
export type OmsConfig = OmsProjectConfig;

export const normalizeUserConfig = normalizeProjectUserConfig;

function normalizeUserProfilesConfig(profiles: OmsProjectUserConfig['profiles']):
ProjectProfilesConfig {
  const headless = profiles?.headless;
  return {
    default: {
      include: undefined,
      exclude: normalizeProfileFilter(profiles?.default?.exclude),
      build: {
        target: undefined,
      },
    },
    headless: headless === undefined
      ? undefined
      : {
        include: normalizeProfileFilter(headless.include),
        exclude: normalizeProfileFilter(headless.exclude),
        build: {
          target: headless.build?.target,
        },
      },
  };
}

function normalizeProfileFilter(filter: readonly string[] | undefined) {
  if (filter === undefined) {
    return undefined;
  }
  const matchers = filter.map((pattern) => picomatch(pattern, {
    windows: platform === 'win32',
  }));
  return (path: string) => {
    return matchers.some((matcher) => matcher(path));
  };
}
