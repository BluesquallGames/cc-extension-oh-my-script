import { platform } from 'node:process';
import picomatch from 'picomatch';

export interface OmsProjectUserConfig {
  resolve?: {
    alias?: Record<string, string>;
    maybeExternals?: string[];
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
      }
      : { alias: undefined, maybeExternals: undefined },

    headless: normalizeUserHeadlessConfig(userConfig.headless),
  };
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
