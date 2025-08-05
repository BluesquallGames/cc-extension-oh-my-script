import { resolve } from 'node:path';

export const selfPackageJson: {
  name: string;
  version: string;
  extensionName?: string;
} = require(resolve(__dirname, '..', 'package.json'));

export const selfExtensionName = selfPackageJson.extensionName ?? selfPackageJson.name;

export const selfPackagePath = resolve(__dirname, '..');
