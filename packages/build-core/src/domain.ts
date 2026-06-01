import assert from 'node:assert';
import { Bundle, BundleUsage } from './bundle.js';
import type { UUIDManager } from './uuid-manager.js';
import fs from 'fs-extra';
import { dirname, join, relative, resolve } from 'node:path';
import { logger } from './logger.js';
import { domainURLProtocol } from './constants.js';
import type { HeadlessConfig } from './config.js';
import { isOmsConfigFileName, loadOmsConfigModule } from './config-loader.js';
import { makeOmsExportEntryId } from './utils/entry-id.js';
import type { InternalBuildEntry } from './build-record.js';

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
    private _headlessConfig: HeadlessConfig | undefined,
    exportPackageName?: string,
  ) {
    this._exportPackageName = exportPackageName ?? _id;

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

      if (this._headlessConfig && this._headlessConfig.enabled) {
        const headlessBundleId = `${domainId}.headless`;
        this._headlessBundle = new Bundle(headlessBundleId, _partitions.map((p) => join(this._domainRoot, p.rootDir)), uuidManager, BundleUsage.headless);
        this._bundles[headlessBundleId] = this._headlessBundle;
      }
    }
  }

  get exportPackageName() {
    return this._exportPackageName;
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
        const entryName = makeOmsExportEntryId(this._exportPackageName, key);
        entrySpecs[entryName] = {
          source: {
            module: join(this._domainRoot, value),
          },
          exportId: entryName,
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
    const exportId = normalizeExportId(exportSubpath);
    const subpath = this._exports[exportId];
    if (!subpath) {
      return undefined;
    }
    return join(this._domainRoot, subpath);
  }

  generateTypingEntries(): DomainTypingEntry[] {
    return Object.entries(this._exports).map(([exportId, exportValue]) => {
      return {
        moduleId: makeOmsImportSpecifier(this._exportPackageName, exportId),
        packageName: makeOmsTypingPackageSpecifier(this._exportPackageName, exportId),
        source: join(this._domainRoot, exportValue),
      };
    });
  }

  private _exportPackageName: string;
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
    if (!headlessConfig || !headlessConfig.enabled) {
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
  source: InternalBuildEntry;
  exportId?: string;
  autoRun?: {
    bundleId: string;
    isEditorEntry: boolean;
  };
}

export interface DomainTypingEntry {
  moduleId: string;
  packageName: string;
  source: string;
}

export interface OmsDomainUserConfig {
  exportPackageName?: string;
  partitions?: PackageOmsPartitionConfig[];
  exports?: Record<string, string>;
}

export interface OmsDomainConfig {
  exportPackageName?: string;
  partitions: PackageOmsPartitionConfig[];
  exports: Record<string, string>;
}

export async function readOmsDomainConfig(domainRoot: string, options: {
  preferredSourceRoot: string;
  configFile?: string | null;
}): Promise<OmsDomainConfig> {
  const packageConfig = await readLegacyPackageDomainConfig(domainRoot);
  const configFile = options.configFile === undefined
    ? await findOmsDomainConfigFile(domainRoot)
    : options.configFile;
  const fileConfig = configFile
    ? await readOmsDomainConfigFile(resolve(domainRoot, configFile))
    : {};

  const partitions = normalizePartitions(
    fileConfig.partitions ?? packageConfig.partitions ?? [{ rootDir: options.preferredSourceRoot }],
    domainRoot,
  );
  const exportPackageName = normalizeExportPackageName(fileConfig.exportPackageName, `In ${configFile ?? 'oms.config.js'}`);
  const fileExports = normalizeDomainExports(fileConfig.exports ?? {}, `In ${configFile ?? 'oms.config.js'}`);

  const config: OmsDomainConfig = {
    partitions,
    exports: fileExports,
  };
  if (exportPackageName !== undefined) {
    config.exportPackageName = exportPackageName;
  }
  return config;
}

async function readLegacyPackageDomainConfig(domainRoot: string): Promise<Partial<OmsDomainConfig>> {
  const domainPackageJson = await readDomainPackageJson(domainRoot);
  if (!domainPackageJson) {
    return {};
  }
  const partitions = domainPackageJson.oms.partitions;
  return {
    partitions,
  };
}

async function findOmsDomainConfigFile(domainRoot: string) {
  if (!await fs.pathExists(domainRoot)) {
    return null;
  }
  const entries = await fs.readdir(domainRoot);
  return entries.filter(isOmsConfigFileName).sort()[0] ?? null;
}

async function readOmsDomainConfigFile(path: string): Promise<OmsDomainUserConfig> {
  try {
    const config = await loadOmsConfigModule<OmsDomainUserConfig>(path);
    if (typeof config !== 'object' || !config) {
      logger.error(`OMS domain config ${path} should export an object`);
      return {};
    }
    return config;
  } catch (err) {
    logger.error(`Error loading OMS domain config ${path}: %o`, err);
    return {};
  }
}

function normalizePartitions(partitions: PackageOmsPartitionConfig[], configDir: string) {
  return partitions.map((partition) => {
    if (typeof partition !== 'object' || !partition || typeof partition.rootDir !== 'string') {
      return undefined;
    }
    return {
      rootDir: relative(configDir, join(configDir, partition.rootDir)),
    };
  }).filter((partition): partition is PackageOmsPartitionConfig => partition !== undefined);
}

function normalizeExportPackageName(exportPackageName: unknown, logPrefix: string) {
  if (exportPackageName === undefined) {
    return undefined;
  }
  if (typeof exportPackageName !== 'string' || exportPackageName.length === 0) {
    logger.error(`${logPrefix}, exportPackageName should be a non-empty string`);
    return undefined;
  }
  if (/[/\\]/.test(exportPackageName)) {
    logger.error(`${logPrefix}, exportPackageName should not contain slashes`);
    return undefined;
  }
  return exportPackageName;
}

function normalizeDomainExports(exports: Record<string, string>, logPrefix: string) {
  const normalizedExports: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(exports)) {
    if (typeof rawValue !== 'string') {
      logger.error(`${logPrefix}, Export { ${rawKey}:${String(rawValue)} } should name a string path`);
      continue;
    }
    const key = normalizeExportId(rawKey);
    if (rawValue === '.') {
      normalizedExports[key] = rawValue;
      continue;
    }
    const expectedHead = './';
    if (!rawValue.startsWith(expectedHead)) {
      logger.error(`${logPrefix}, Export { ${rawKey}:${rawValue} } should name a path starting with ${expectedHead}`);
      continue;
    }
    normalizedExports[key] = rawValue.slice(expectedHead.length);
  }
  return normalizedExports;
}

function normalizeExportId(exportId: string) {
  if (exportId === '' || exportId === '.') {
    return '.';
  }
  return exportId.replace(/^\.\//, '').replace(/^\/+/, '');
}

function makeOmsImportSpecifier(exportPackageName: string, exportId: string) {
  const path = exportId === '.' ? '' : `/${exportId}`;
  return `${domainURLProtocol}://${exportPackageName}${path}`;
}

function makeOmsTypingPackageSpecifier(exportPackageName: string, exportId: string) {
  const suffix = exportId === '.' ? '' : `__${sanitizeTypingPackageNameSegment(exportId)}`;
  return `@oms-exports/${sanitizeTypingPackageNameSegment(exportPackageName)}${suffix}`;
}

function sanitizeTypingPackageNameSegment(segment: string) {
  return segment.replace(/[^a-zA-Z0-9._-]/g, (ch) => {
    return `_${ch.charCodeAt(0).toString(16)}_`;
  });
}

export interface DomainPackageJson {
  _path: string;
  oms: PackageOmsConfig;
}

export async function readDomainPackageJson(domainRoot: string) {
  const packageJsonPath = join(domainRoot, 'package.json');
  if (!await fs.pathExists(packageJsonPath)) {
    return undefined;
  }
  const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));
  if (typeof packageJson !== 'object' || !packageJson) {
    return undefined;
  }
  const normalizedPackageJson: DomainPackageJson = {
    _path: packageJsonPath,
    oms: {},
  };
  normalizedPackageJson.oms = parsePackageJsonOms(packageJson.oms, dirname(packageJsonPath)) ?? {};
  return normalizedPackageJson;
}

export interface PackageOmsPartitionConfig {
  rootDir: string;
}

interface PackageOmsConfig {
  partitions?: PackageOmsPartitionConfig[];
}

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
