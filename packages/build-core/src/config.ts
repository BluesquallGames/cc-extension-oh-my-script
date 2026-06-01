import { platform } from 'node:process';
import picomatch from 'picomatch';
import { logger } from './logger.js';
import { getBarePackageName } from './utils/package-name.js';

export interface OmsProjectUserConfig {
  resolve?: {
    alias?: Record<string, string>;
    maybeExternals?: string[];
    projectPeers?: string[];
  };

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
    maybeExternals: undefined | string[];
    projectPeers: string[];
  };

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
        maybeExternals: userConfig.resolve.maybeExternals,
        projectPeers: normalizeProjectPeers(userConfig.resolve.projectPeers),
      }
      : { alias: undefined, maybeExternals: undefined, projectPeers: [] },

    headless: normalizeUserHeadlessConfig(userConfig.headless),
  };
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
