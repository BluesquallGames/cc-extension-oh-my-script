import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { OmsConfigContext } from './config.js';

export function isOmsConfigFileName(path: string) {
  return /^oms\.config\.[cm]?js$/.test(basename(path));
}

export async function loadOmsConfigModule<TUserConfig>(path: string, context:
OmsConfigContext): Promise<TUserConfig> {
  const { default: config } = await import(pathToFileURL(path).href + '?timestamp='
    + Date.now()) as {
    default: TUserConfig | ((context: OmsConfigContext) => TUserConfig | Promise<TUserConfig>);
  };
  if (typeof config === 'function') {
    return await (config as (context: OmsConfigContext) => TUserConfig
      | Promise<TUserConfig>)(context);
  }
  return config;
}
