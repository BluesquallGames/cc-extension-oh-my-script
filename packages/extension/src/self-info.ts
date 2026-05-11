import { resolve } from 'node:path';
import packageJson from '../package.json' with { type: 'json' };

export const selfPackageJson: {
  name: string;
  version: string;
  extensionName?: string;
} = packageJson;

export const selfExtensionName = selfPackageJson.extensionName ?? selfPackageJson.name;

export const selfPackagePath = resolve(__dirname, '../../../');
