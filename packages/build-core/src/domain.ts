import assert from 'node:assert';
import { Bundle } from './bundle.js';
import { extractInlineUUID, UUIDManager } from './uuid-manager.js';
import fs from 'fs-extra';
import { dirname, join, relative, resolve } from 'node:path';
import { logger } from './logger.js';
import { domainURLProtocol } from './constants.js';
import { isOmsConfigFileName, loadOmsConfigModule } from './config-loader.js';
import { makeOmsExportEntryId } from './utils/entry-id.js';
import type { InternalBuildEntry } from './build-record.js';

export interface DomainProfile {
  id: string;
  sourceMatcher: (relativePath: string) => boolean;
  bundle: {
    idSuffix: string;
    indexPreStem: string;
    indexPostStem: string;
  };
}

export interface ProfileBuildOptions {
  editor?: boolean;
  dynamicExports?: boolean;
}

export class Domain {
  constructor(
    private _id: string,
    private _domainRoot: string,
    private _partitions: PackageOmsPartitionConfig[],
    private _exports: Record<string, string>,
    private _uuidManager: UUIDManager,
    profiles: DomainProfile[],
    exportPackageName?: string,
  ) {
    this._exportPackageName = exportPackageName ?? _id;

    const indexModuleDirs = this.sourceRoots;
    for (const profile of profiles) {
      assert.ok(!this._profileStates[profile.id], `Duplicate profile ${profile.id} in domain ${this._id}`);
      const bundleId = `${this._id}${profile.bundle.idSuffix}`;
      this._profileStates[profile.id] = {
        sourceMatcher: profile.sourceMatcher,
        bundle: new Bundle({
          id: bundleId,
          indexModuleDirs,
          indexPreStem: profile.bundle.indexPreStem,
          indexPostStem: profile.bundle.indexPostStem,
        }),
        editorBundle: new Bundle({
          id: `${bundleId}.editor`,
          indexModuleDirs,
          indexPreStem: `${profile.bundle.indexPreStem}.editor`,
          indexPostStem: `${profile.bundle.indexPostStem}.editor`,
        }),
      };
    }
  }

  get exportPackageName() {
    return this._exportPackageName;
  }

  get sourceRoots() {
    return this._partitions.map((p) => join(this._domainRoot, p.rootDir));
  }

  getEntrySpecs(profileId: string, opts: ProfileBuildOptions = {}): Record<string, BundleEntrySpec> {
    const entrySpecs: Record<string, BundleEntrySpec> = {};

    const profileState = this._profileStates[profileId];
    if (profileState) {
      const bundles = [profileState.bundle, opts.editor ? profileState.editorBundle : undefined];
      for (const bundle of bundles) {
        if (!bundle) {
          continue;
        }
        if (bundle.empty) {
          continue;
        }
        const bundleId = bundle.id;
        entrySpecs[`bundle-${bundleId}`] = {
          source: bundle.entrySource,
          autoRun: {
            bundleId,
            isEditorEntry: bundle === profileState.editorBundle,
          },
        };
      }
    }

    if (opts.dynamicExports !== false) {
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

    logger.debug(`Entry specs for domain ${this._id}: ${JSON.stringify(entrySpecs, undefined, 2)}`);

    return entrySpecs;
  }

  getImplicitEntries(profileId: string, opts: ProfileBuildOptions = {}): string[] {
    const profileState = this._profileStates[profileId];
    if (!profileState) {
      return [];
    }
    const implicitEntries = new Set<string>();
    const bundles = [profileState.bundle, opts.editor ? profileState.editorBundle : undefined];
    for (const bundle of bundles) {
      if (!bundle) {
        continue;
      }
      for (const implicitEntry of bundle.getImplicitEntries()) {
        implicitEntries.add(implicitEntry);
      }
    }
    return [...implicitEntries];
  }

  async addSourceFile(path: string) {
    const bundles = this._getSourceFileBundles(path);
    if (this._isComponentModule(path)) {
      await this._ensureUUID(path);
    }
    let shouldRebuildBundle = false;
    for (const bundle of bundles) {
      shouldRebuildBundle = bundle.addSourceFile(path) || shouldRebuildBundle;
    }
    return shouldRebuildBundle;
  }

  removeSourceFile(path: string) {
    const bundles = this._getSourceFileBundles(path);
    if (this._isComponentModule(path)) {
      this._uuidManager.delete(path);
    }
    let shouldRebuildBundle = false;
    for (const bundle of bundles) {
      shouldRebuildBundle = bundle.removeSourceFile(path) || shouldRebuildBundle;
    }
    return shouldRebuildBundle;
  }

  async updateSourceFile(path: string) {
    if (this._isComponentModule(path)) {
      await this._ensureUUID(path);
    }
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
  private _profileStates: Record<string, {
    sourceMatcher: DomainProfile['sourceMatcher'];
    bundle: Bundle;
    editorBundle: Bundle;
  }> = {};

  private _getSourceFileBundles(path: string): Bundle[] {
    const sourceRoots = this.sourceRoots;
    if (!sourceRoots.some((sourceRoot) => path.startsWith(sourceRoot))) {
      throw new Error(`Bundle for ${path} not found in domain ${this._id}, root dirs: ${sourceRoots.join(', ')}`);
    }

    const bundles: Bundle[] = [];
    const isEditorModule = /\.editor\.\w+$/.test(path);
    const relativePath = relative(this._domainRoot, path);
    for (const profileState of Object.values(this._profileStates)) {
      const bundle = isEditorModule ? profileState.editorBundle : profileState.bundle;
      if (bundle.isIndexModule(path)
        || (bundle.isComponentModule(path) && profileState.sourceMatcher(relativePath))) {
        bundles.push(bundle);
      }
    }
    return bundles;
  }

  private _isComponentModule(path: string) {
    return Object.values(this._profileStates).some(({ bundle }) => bundle.isComponentModule(path));
  }

  private async _ensureUUID(sourceFile: string) {
    try {
      const code = await fs.readFile(sourceFile, 'utf8');
      const inlineUUID = extractInlineUUID(code) ?? '';
      await this._uuidManager.update(sourceFile, inlineUUID);
    } catch (err) {
      logger.error(`Failed to assign UUID for ${sourceFile}: %o`, err);
    }
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
