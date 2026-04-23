import assert from 'node:assert';
import { Bundle, BundleUsage } from './bundle.js';
import type { UUIDManager } from './uuid-manager.js';
import fs from 'fs-extra';
import { dirname, join, relative } from 'node:path';
import { logger } from './logger.js';
import { glob } from 'node:fs/promises';
import { domainURLProtocol } from './constants.js';
import type { HeadlessConfig } from './config.js';

export interface DomainEntryQueryOptions {
  regular: boolean;
  editor: boolean;
  headless: boolean;
}

export class Domain {
  constructor(
    private _id: string,
    private _domainRoot: string,
    private _partitions: PackageOmsPartitionConfig[],
    private _exports: Record<string, string>,
    uuidManager: UUIDManager,
    private _headlessConfig: HeadlessConfig,
  ) {
    {
      const domainId = this._id;

      const mainBundleId = domainId;
      this._mainBundle = new Bundle(mainBundleId, _partitions.map((p) => join(this._domainRoot, p.rootDir)), uuidManager, BundleUsage.regular);
      this._bundles[mainBundleId] = this._mainBundle;
      for (const partition of _partitions) {
        this._bundleSourceRootMap.push({ sourceRoot: join(this._domainRoot, partition.rootDir), bundleId: mainBundleId });
      }

      const editorBundleId = `${domainId}.editor`;
      this._editorBundle = new Bundle(editorBundleId, _partitions.map((p) => join(this._domainRoot, p.rootDir)), uuidManager, BundleUsage.editor);
      this._bundles[editorBundleId] = this._editorBundle;

      if (this._headlessConfig.enabled) {
        const headlessBundleId = `${domainId}.headless`;
        this._headlessBundle = new Bundle(headlessBundleId, _partitions.map((p) => join(this._domainRoot, p.rootDir)), uuidManager, BundleUsage.headless);
        this._bundles[headlessBundleId] = this._headlessBundle;
      }
    }
  }

  get sourceRoots() {
    return this._partitions.map((p) => join(this._domainRoot, p.rootDir));
  }

  getEntrySpecs(opts: DomainEntryQueryOptions): Record<string, BundleEntrySpec> {
    const entrySpecs: Record<string, BundleEntrySpec> = {};

    for (const [bundleId, bundle] of Object.entries(this._bundles)) {
      if (bundle === this._editorBundle) {
        if (!opts.editor) {
          continue;
        }
      } else if (bundle === this._headlessBundle) {
        if (!opts.headless) {
          continue;
        }
      } else {
        if (!opts.regular) {
          continue;
        }
      }
      if (bundle.empty) {
        continue;
      }
      entrySpecs[`bundle-${bundleId}`] = {
        source: bundle.entrySource,
        autoRun: {
          bundleId,
          isEditorEntry: bundle === this._editorBundle,
        },
      };
    }

    if (opts.regular) {
      for (const [key, value] of Object.entries(this._exports)) {
        let entryName = '';
        if (key === '.') {
          entryName = `${this._id}-export`;
        } else {
          entryName = `${this._id}-export/${key.startsWith('./') ? key.slice(2) : key}`;
        }
        entrySpecs[entryName] = {
          source: `export * from ${JSON.stringify(join(this._domainRoot, value))}`,
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

  resolveExport(exportSubpath: string): string | undefined {
    const subpath = this._exports[exportSubpath === '.' ? '.' : `./${exportSubpath}`];
    if (!subpath) {
      return undefined;
    }
    return join(this._domainRoot, subpath);
  }

  generatePathMappings() {
    return Object.fromEntries(Object.entries(this._exports).map(([exportId, exportValue]) => {
      const path = exportId === '.' ? '' : `/${exportId.replace(/^\.\//, '')}`;
      return [
        `${domainURLProtocol}://${this._id}${path}`,
        [join(this._domainRoot, exportValue)],
      ];
    }));
  }

  private _mainBundle: Bundle;
  private _editorBundle: Bundle;
  private _headlessBundle: Bundle | undefined;
  private _bundles: Record<string, Bundle> = {};
  private _bundleSourceRootMap: Array<{
    sourceRoot: string;
    bundleId: string;
  }> = [];

  private _getBundle(path: string) {
    if (/\.editor\.\w+$/.test(path)) {
      return this._editorBundle;
    }
    if (this._headlessBundle && this._testHeadlessModule(path)) {
      return this._headlessBundle;
    }
    const bundleId = this._bundleSourceRootMap.find(({ sourceRoot }) => path.startsWith(sourceRoot))?.bundleId;
    if (!bundleId) {
      throw new Error(`Bundle for ${path} not found in domain ${this._id}, root dirs: ${this._bundleSourceRootMap.map(({ sourceRoot }) => sourceRoot).join(', ')}`);
    }
    const bundle = this._bundles[bundleId];
    assert.ok(bundle, `Bundle for ${path} not found in domain ${this._id}`);
    return bundle;
  }

  private _testHeadlessModule(path: string): boolean {
    const headlessConfig = this._headlessConfig;
    if (!headlessConfig.enabled) {
      return false;
    }
    if (this._headlessBundle?.isHeadlessModule(path)) {
      return true;
    }
    const relativePath = relative(this._domainRoot, path);
    if (headlessConfig.include) {
      if (!headlessConfig.include(relativePath)) {
        return false;
      }
    }
    if (headlessConfig.exclude) {
      if (headlessConfig.exclude(relativePath)) {
        return false;
      }
    }
    return true;
  }
}

export interface BundleEntrySpec {
  source: string;
  autoRun?: {
    bundleId: string;
    isEditorEntry: boolean;
  };
}

export async function readDomainExports(domainRoot: string, partitions: PackageOmsPartitionConfig[], domainPackageJson: DomainPackageJson | undefined): Promise<Record<string, string>> {
  if (!domainPackageJson || !domainPackageJson.exports) {
    return {};
  }
  const domainSourceRoots = partitions.map((p) => join(domainRoot, p.rootDir));
  const exports = collectExports(domainPackageJson.exports, ['oms', 'module', 'import']);
  const fileExports: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(exports)) {
    if (rawValue === '.') {
      fileExports[key] = rawValue;
      continue;
    }
    const expectedHead = './';
    if (!rawValue.startsWith(expectedHead)) {
      logger.error(`In ${domainPackageJson._path}, Export { ${key}:${rawValue} } should name a path starting with ${expectedHead}`);
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
      logger.error(`In ${domainPackageJson._path}, Export { ${key}:${rawValue} } does not mismatch`);
      continue;
    }
    const valuePrefix = value.slice(0, iValueAsterisk);
    const valuePostfix = value.slice(iValueAsterisk + 1);
    const keyPrefix = key.slice(0, iKeyAsterisk);
    const keyPostfix = key.slice(iKeyAsterisk + 1);
    const expandedValues = searchPotentialExportFiles(domainSourceRoots, valuePrefix, valuePostfix);
    for await (const expandedValue of expandedValues) {
      fileExports[`${keyPrefix}${expandedValue}${keyPostfix}`] = `${valuePrefix}${expandedValue}${valuePostfix}`;
    }
  }
  return fileExports;
}

async function* searchPotentialExportFiles(rootDirs: string[], prefix: string, postfix: string): AsyncGenerator<string> {
  for (const rootDir of rootDirs) {
    for await (const file of readFilesRecursive(rootDir)) {
      if (file.startsWith(prefix) && file.endsWith(postfix)) {
        yield file.slice(prefix.length, -postfix.length);
      }
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

export interface DomainPackageJson {
  _path: string;
  exports: null | PackageExports;
  oms: PackageOmsConfig;
}

export async function readDomainPackageJson(domainRoot: string) {
  const packageJsonPath = join(domainRoot, 'package.json');
  if (!fs.pathExists(packageJsonPath)) {
    return undefined;
  }
  const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));
  if (typeof packageJson !== 'object' || !packageJson.exports) {
    return undefined;
  }
  const normalizedPackageJson: DomainPackageJson = {
    _path: packageJsonPath,
    exports: null,
    oms: {},
  };
  const rawExports = packageJson.exports;
  if (validatePackageExports(rawExports)) {
    normalizedPackageJson.exports = rawExports;
  }
  normalizedPackageJson.oms = parsePackageJsonOms(packageJson.oms, dirname(packageJsonPath)) ?? {};
  return normalizedPackageJson;
}

interface PackageOmsPartitionConfig {
  rootDir: string;
}

interface PackageOmsConfig {
  partitions?: PackageOmsPartitionConfig[];
}

type PackageExports = string | string[] | Record<string, string | ConditionalPackageExports>;

type ConditionalPackageExports = {
  [key: string]: null | string | ConditionalPackageExports;
};

function parsePackageJsonOms(oms: unknown, packageJsonDir: string) {
  if (typeof oms !== 'object' || !oms) {
    return undefined;
  }
  const omsConfig: PackageOmsConfig = {};

  if ('partitions' in oms && Array.isArray(oms.partitions)) {
    omsConfig.partitions = oms.partitions.map((partition) => {
      if (!('rootDir' in partition) || typeof partition.rootDir !== 'string') {
        return;
      }
      return {
        rootDir: relative(packageJsonDir, join(packageJsonDir, partition.rootDir)),
      };
    }).filter((partition): partition is PackageOmsPartitionConfig => partition !== undefined);
  }

  return omsConfig;
}

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
