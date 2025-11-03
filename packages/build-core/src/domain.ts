import assert from 'node:assert';
import { Bundle } from './bundle.js';
import type { UUIDManager } from './uuid-manager.js';
import fs from 'fs-extra';
import { join, normalize, relative } from 'node:path';
import { logger } from './logger.js';
import { glob } from 'node:fs/promises';

export class Domain {
  constructor(
    private _id: string,
    private _domainRoot: string,
    private _sourceRoot: string,
    private _exports: Record<string, string>,
    uuidManager: UUIDManager,
  ) {
    {
      const bundleId = this._id;
      const sourceRoot = this._sourceRoot;
      this._mainBundle = new Bundle(bundleId, sourceRoot, uuidManager);
      this._bundles[bundleId] = this._mainBundle;
      this._bundleSourceRootMap.push({ sourceRoot, bundleId });
    }
  }

  getEntrySpecs(): Record<string, BundleEntrySpec> {
    const entrySpecs: Record<string, BundleEntrySpec> = {};

    for (const [bundleId, bundle] of Object.entries(this._bundles)) {
      if (bundle.empty) {
        continue;
      }
      entrySpecs[`bundle-${bundleId}`] = {
        source: bundle.entrySource,
        autoRun: {
          bundleId,
        },
      };
    }

    for (const [key, value] of Object.entries(this._exports)) {
      if (key === '.') {
        entrySpecs[`${this._id}-export`] = {
          source: join(this._sourceRoot, value),
        };
      } else {
        entrySpecs[`${this._id}-export/${key.startsWith('./') ? key.slice(2) : key}`] = {
          source: `export * from ${JSON.stringify(join(this._sourceRoot, value))}`,
        };
      }
    }

    logger.verbose(`Entry specs for domain ${this._id}: ${JSON.stringify(entrySpecs, undefined, 2)}`);

    return entrySpecs;
  }


  getImplicitEntries(): string[] {
    const implicitEntries = new Set<string>();
    for (const bundle of Object.values(this._bundles)) {
      for (const implicitEntry of bundle.getImplicitEntries()) {
        implicitEntries.add(implicitEntry);
      }
    }
    return [...implicitEntries];
  }

  async addSourceFile(path: string) {
    const bundle = this._getBundle(path);
    return bundle.addSourceFile(path);
  }

  async removeSourceFile(path: string) {
    const bundle = this._getBundle(path);
    return bundle.removeSourceFile(path);
  }

  async updateSourceFile(path: string) {
    const bundle = this._getBundle(path);
    return bundle.updateSourceFile(path);
  }
  
  private _mainBundle: Bundle;
  private _bundles: Record<string, Bundle> = {};
  private _bundleSourceRootMap: Array<{
    sourceRoot: string;
    bundleId: string;
  }> = [];

  private _getBundle(path: string) {
    const bundleId = this._bundleSourceRootMap.find(({ sourceRoot }) => path.startsWith(sourceRoot))?.bundleId;
    if (!bundleId) {
      throw new Error(`Bundle for ${path} not found`);
    }
    const bundle = this._bundles[bundleId];
    assert.ok(bundle, `Bundle for ${path} not found`);
    return bundle;
  }
}

export interface BundleEntrySpec {
  source: string;
  autoRun?: {
    bundleId: string;
  };
}

export async function readDomainExports(domainRoot: string, domainSourceRoot: string): Promise<Record<string, string>> {
  const packageJson = await readDomainPackageJson(domainRoot);
  if (!packageJson || !packageJson.exports) {
    return {};
  }
  const exports = collectExports(packageJson.exports, ['oms', 'module', 'import']);
  const fileExports: Record<string, string> = {};
  const relativeDomainSourceRoot = relative(domainRoot, domainSourceRoot);
  for (const [key, rawValue] of Object.entries(exports)) {
    if (rawValue === '.') {
      fileExports[key] = rawValue;
      continue;
    }
    const expectedHead = './' + normalize(`${relativeDomainSourceRoot}/`).replace(/\\/g, '/');
    if (!rawValue.startsWith(expectedHead)) {
      logger.error(`In ${packageJson._path}, Export { ${key}:${rawValue} } should name a path starting with ${expectedHead}`);
      continue;
    }
    const value = rawValue.slice(expectedHead.length);
    const iValueAsterisk = value.indexOf('*');
    if (iValueAsterisk < 0) {
      fileExports[key] = value;
      continue;
    }
    const iKeyAsterisk = key.indexOf('*');
    if (iKeyAsterisk < 0) {
      logger.error(`In ${packageJson._path}, Export { ${key}:${rawValue} } does not mismatch`);
      continue;
    }
    const valuePrefix = value.slice(0, iValueAsterisk);
    const valuePostfix = value.slice(iValueAsterisk + 1);
    const keyPrefix = key.slice(0, iKeyAsterisk);
    const keyPostfix = key.slice(iKeyAsterisk + 1);
    const expandedValues = searchPotentialExportFiles(domainSourceRoot, valuePrefix, valuePostfix);
    for await (const expandedValue of expandedValues) {
      fileExports[`${keyPrefix}${expandedValue}${keyPostfix}`] = `${valuePrefix}${expandedValue}${valuePostfix}`;
    }
  }
  return fileExports;
}

async function* searchPotentialExportFiles(root: string, prefix: string, postfix: string): AsyncGenerator<string> {
  for await (const file of readFilesRecursive(root)) {
    if (file.startsWith(prefix) && file.endsWith(postfix)) {
      return file.slice(prefix.length, -postfix.length);
    }
  }
}

async function* readFilesRecursive(root: string): AsyncGenerator<string> {
  for await (const file of glob('**/*', {
    cwd: root,
  })) {
    let p = file.slice(root.length);
    if (p.startsWith('/')) {
      p = p.slice(1);
    }
    yield p;
  }
}

async function readDomainPackageJson(domainRoot: string) {
  const packageJsonPath = join(domainRoot, 'package.json');
  if (!fs.pathExists(packageJsonPath)) {
    return;
  }
  const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));
  if (typeof packageJson !== 'object' || !packageJson.exports) {
    return;
  }
  const normalizedPackageJson: {
    _path: string,
    exports: null | PackageExports;
  } = {
    _path: packageJsonPath,
    exports: null,
  };
  const rawExports = packageJson.exports;
  if (validatePackageExports(rawExports)) {
    normalizedPackageJson.exports = rawExports;
  }
  return normalizedPackageJson;
}

type PackageExports = string | string[] | Record<string, string | ConditionalPackageExports>;

type ConditionalPackageExports = {
  [key: string]: null | string | ConditionalPackageExports;
};

function validatePackageExports(exports: unknown): exports is PackageExports {
  if (typeof exports === 'string') {
    return true;
  }
  if (Array.isArray(exports)) {
    return exports.every((value) => typeof value === 'string');
  }
  if (typeof exports === 'object' && exports) {
    return Object.values(exports).every((value) => {
      if (typeof value === 'string') {
        return true;
      } else if (typeof value === 'object' && value !== null) {
        return validateConditionalPackageExports(value);
      }
      return false;
    });
  }
  return false;
}

function validateConditionalPackageExports(exports: ConditionalPackageExports): exports is ConditionalPackageExports {
  for (const [_, value] of Object.entries(exports)) {
    if (value === null) {
      continue;
    }
    if (typeof value === 'string') {
      continue;
    }
    if (typeof value === 'object') {
      if (validateConditionalPackageExports(value)) {
        continue;
      }
    }
    return false;
  }
  return true;
}

function collectExports(exports: PackageExports, conditions: string[]): Record<string, string> {
  if (typeof exports === 'string') {
    return {
      '.': exports,
    };
  } else if (Array.isArray(exports)) {
    return Object.fromEntries(exports.map((value) => {
      return [value, value];
    }));
  } else {
    const resultExports: Record<string, string> = {};
    for (const [key, value] of Object.entries(exports)) {
      if (value === null) {
        continue;
      }
      if (typeof value === 'string') {
        resultExports[key] = value;
        continue;
      }
      const resolved = resolveConditionalExports(value, conditions);
      if (resolved) {
        resultExports[key] = resolved;
      }
    }
    return resultExports;
  }
}

function resolveConditionalExports(exports: ConditionalPackageExports, conditions: string[]): string | null {
  for (const [key, value] of Object.entries(exports)) {
    if (value === null) {
      continue;
    }
    if (typeof value === 'string') {
      return value;
    }
    if (conditions.includes(key)) {
      return resolveConditionalExports(value, conditions);
    }
  }
  return null;
}
