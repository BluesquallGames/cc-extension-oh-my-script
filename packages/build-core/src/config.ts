import { platform } from 'node:process';
import picomatch from 'picomatch';
import { logger } from './logger.js';
import { getBarePackageName } from './utils/package-name.js';

export interface OmsProjectUserConfig {
  resolve?: {
    alias?: Record<string, string>;
    projectPeers?: string[];
  };

  define?: Record<string, unknown>;
  mode?: string;
  envDir?: string;
  envPrefix?: string | unknown[];

  headless?: boolean | {
    enabled?: boolean;
    include?: string[];
    exclude?: string[];
    build?: {
      target?: string;
    };
  };
}

export interface OmsProjectConfig {
  resolve: {
    alias?: Record<string, string>;
    projectPeers: string[];
  };

  define: Record<string, string>;
  mode: string;
  envDir: string | undefined;
  envPrefix: string[];

  headless: HeadlessConfig;
}

export interface HeadlessConfig {
  enabled: boolean;
  include?: (string: string) => boolean;
  exclude?: (string: string) => boolean;
  build: ProfileBuildConfig;
}

export interface ProfileBuildConfig {
  target: string | undefined;
}

export function normalizeProjectUserConfig(userConfig: OmsProjectUserConfig): OmsProjectConfig {
  return {
    resolve: userConfig.resolve
      ? {
        alias: userConfig.resolve.alias,
        projectPeers: normalizeProjectPeers(userConfig.resolve.projectPeers),
      }
      : { alias: undefined, projectPeers: [] },

    define: normalizeDefine(userConfig.define),
    mode: normalizeMode(userConfig.mode),
    envDir: normalizeEnvDir(userConfig.envDir),
    envPrefix: normalizeEnvPrefix(userConfig.envPrefix),
    headless: normalizeUserHeadlessConfig(userConfig.headless),
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
      logger.error(`define entry ${key} should be JSON serializable or a JavaScript expression string`);
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

function normalizeUserHeadlessConfig(headlessConfig: OmsProjectUserConfig['headless']): HeadlessConfig {
  const defaultHeadlessConfig: HeadlessConfig = {
    enabled: false,
    build: {
      target: undefined,
    },
  };
  if (headlessConfig === true) {
    return {
      ...defaultHeadlessConfig,
      enabled: true,
    };
  }
  if (!(typeof headlessConfig === 'object' && headlessConfig)) {
    return {
      ...defaultHeadlessConfig,
      enabled: false,
    };
  }
  return {
    ...defaultHeadlessConfig,
    enabled: headlessConfig.enabled ?? true,
    include: normalizeHeadlessFilter(headlessConfig.include ?? []),
    exclude: normalizeHeadlessFilter(headlessConfig.exclude ?? []),
    build: {
      target: headlessConfig.build?.target,
    },
  };
}

function normalizeHeadlessFilter(filter: string[]) {
  const matchers = filter.map((pattern) => picomatch(pattern, {
    windows: platform === 'win32',
  }));
  return (path: string) => {
    return matchers.some((matcher) => matcher(path));
  };
}
