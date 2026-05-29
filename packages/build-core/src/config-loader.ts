import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';

export function isOmsConfigFileName(path: string) {
  return /^oms\.config\.[cm]?js$/.test(basename(path));
}

export async function loadOmsConfigModule<TUserConfig>(path: string): Promise<TUserConfig> {
  const { default: config } = await import(pathToFileURL(path).href + '?timestamp=' + Date.now()) as {
    default: TUserConfig | (() => TUserConfig | Promise<TUserConfig>);
  };
  if (typeof config === 'function') {
    return await (config as () => TUserConfig | Promise<TUserConfig>)();
  }
  return config;
}
