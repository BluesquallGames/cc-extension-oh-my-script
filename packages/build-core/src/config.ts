import { platform } from 'node:process';
import picomatch from 'picomatch';

export interface OmsUserConfig {
  resolve?: {
    alias?: Record<string, string>;
    maybeExternals?: string[];
  };

  headless?: boolean | {
    enabled?: boolean;
    include?: string[];
    exclude?: string[];
  };
}

export interface OmsConfig {
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
}

export function normalizeUserConfig(userConfig: OmsUserConfig): OmsConfig {
  return {
    resolve: userConfig.resolve
      ? {
        alias: userConfig.resolve.alias,
        maybeExternals: userConfig.resolve.maybeExternals,
      }
      : { alias: undefined, maybeExternals: undefined },

    headless: userConfig.headless === true
      ? { enabled: true }
      : typeof userConfig.headless === 'object' && userConfig.headless
        ? {
          ...userConfig.headless,
          enabled: userConfig.headless.enabled ?? true,
          include: normalizeHeadlessFilter(userConfig.headless.include ?? []),
          exclude: normalizeHeadlessFilter(userConfig.headless.exclude ?? []),
        }
        : { enabled: false },
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
