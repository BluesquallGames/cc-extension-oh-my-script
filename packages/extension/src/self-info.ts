import { resolve } from 'node:path';
import packageJson from '../package.json' with { type: 'json' };

export const selfPackageJson: {
  name: string;
  version: string;
  vortex: {
    extensionName?: string;
  };
} = packageJson;

export const selfPackageName = selfPackageJson.name;
export const selfExtensionName = selfPackageJson.vortex.extensionName ?? selfPackageName;

export const selfPackagePath = resolve(__dirname, '..');
