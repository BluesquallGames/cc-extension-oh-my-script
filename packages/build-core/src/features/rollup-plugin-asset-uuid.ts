import type { Plugin } from 'rollup';
import babel from '@babel/core';
import { dirname, isAbsolute, resolve } from 'node:path';
import { isPathInside } from '../utils/path.js';

const assetUUIDPrefix = '\0oms:asset-uuid:';
const assetUUIDQuerySuffix = '?uuid';
const assetUUIDImporterQuery = '?uuid&importer=';

interface AssetMeta {
  uuid?: unknown;
  importer?: string;
  subMetas?: Record<string, AssetMeta>;
}

/**
 * Rollup 4 groups static dependencies within a module by specifier before calling resolveId.
 * Imports of the same ?uuid source with different importer attributes would therefore share
 * the first resolution, even if resolveId could return a distinct ID for each selection.
 * Encode the selector in the specifier before Rollup builds its dependency graph, while keeping
 * the attribute available to plugins through options.attributes.
 * Rollup 5 includes attributes in module identity; remove this workaround after migrating.
 * @see https://github.com/rollup/rollup/issues/5694
 */
export function transformAssetUUIDImports(): babel.PluginObj {
  return {
    name: 'oms:asset-uuid-imports',
    visitor: {
      Program(path) {
        for (const statement of path.node.body) {
          if (!babel.types.isImportDeclaration(statement)
            && !babel.types.isExportNamedDeclaration(statement)
            && !babel.types.isExportAllDeclaration(statement)) {
            continue;
          }
          if (!statement.source?.value.endsWith(assetUUIDQuerySuffix)) {
            continue;
          }
          const attribute = statement.attributes?.find(({ key }) =>
            (babel.types.isIdentifier(key) ? key.name : key.value) === 'importer');
          if (!attribute) {
            continue;
          }
          statement.source.value = statement.source.value.slice(0, -assetUUIDQuerySuffix.length)
            + assetUUIDImporterQuery + encodeURIComponent(attribute.value.value);
        }
      },
    },
  };
}

/** Imports asset metadata UUIDs without loading or emitting the asset contents. */
export function rollupPluginAssetUUID({ assetDirs }: {
  assetDirs: string[];
}): Plugin {
  return {
    name: 'oms:asset-uuid',

    async resolveId(source, importer, options) {
      if (source.startsWith(assetUUIDPrefix)) {
        return source;
      }
      const queryIndex = source.lastIndexOf(assetUUIDImporterQuery);
      if (queryIndex === -1 && !source.endsWith(assetUUIDQuerySuffix)) {
        return;
      }
      const { importer: importerAttribute, ...attributes } = options.attributes;
      const assetImporter = queryIndex === -1
        ? importerAttribute
        : decodeURIComponent(source.slice(queryIndex + assetUUIDImporterQuery.length));
      if (assetImporter !== undefined && !assetImporter.trim()) {
        this.error(`Asset UUID import ${source} requires a non-empty importer attribute`);
      }
      const specifier = queryIndex === -1
        ? source.slice(0, -assetUUIDQuerySuffix.length)
        : source.slice(0, queryIndex);
      let file: string;
      if (isAbsolute(specifier)) {
        file = resolve(specifier);
      } else if ((specifier.startsWith('./') || specifier.startsWith('../')) && importer
        && isAbsolute(importer)) {
        file = resolve(dirname(importer), specifier);
      } else {
        const resolved = await this.resolve(specifier, importer, options);
        if (!resolved || resolved.external || !isAbsolute(resolved.id)) {
          this.error(`Cannot resolve asset UUID import ${source} from ${importer
          ?? '<entry>'} to a file`);
        }
        file = resolve(resolved.id);
      }
      if (!assetDirs.some((assetDir) => isPathInside(assetDir, file))) {
        this.error(
          `Asset UUID import ${source} must reference a file inside configured asset directories (${assetDirs.join(', ')}): ${file}`);
      }
      return {
        // Importer selections are distinct modules; NUL cannot occur in a filesystem path.
        id: assetUUIDPrefix + file + (assetImporter === undefined ? '' : `\0${assetImporter}`),
        attributes,
        moduleSideEffects: false,
      };
    },

    async load(id) {
      if (!id.startsWith(assetUUIDPrefix)) {
        return;
      }
      const importerIndex = id.indexOf('\0', assetUUIDPrefix.length);
      const file = id.slice(assetUUIDPrefix.length,
        importerIndex === -1 ? undefined : importerIndex);
      const assetImporter = importerIndex === -1 ? undefined : id.slice(importerIndex + 1);
      const metadata = `${file}.meta`;
      // Register before reading so missing assets and metadata can recover after creation.
      this.addWatchFile(file);
      this.addWatchFile(metadata);
      if (!(await this.fs.stat(file)).isFile()) {
        this.error(`Asset UUID import requires a file: ${file}`);
      }
      let meta: AssetMeta;
      try {
        meta = JSON.parse(
          await this.fs.readFile(metadata, { encoding: 'utf8' }),
        ) as AssetMeta;
      } catch (cause) {
        throw new Error(`Cannot read or parse asset metadata ${metadata}`, { cause });
      }
      let selectedMeta = meta;
      if (assetImporter !== undefined) {
        const matches: AssetMeta[] = [];
        const candidates = [meta];
        for (const candidate of candidates) {
          if (candidate.importer === assetImporter) {
            matches.push(candidate);
          }
          candidates.push(...Object.values(candidate.subMetas ?? {}));
        }
        if (matches.length !== 1) {
          this.error(`Asset metadata ${metadata} must match exactly one resource with importer ${JSON.stringify(assetImporter)}; found ${matches.length}`);
        }
        selectedMeta = matches[0];
      }
      if (typeof selectedMeta.uuid !== 'string' || !selectedMeta.uuid.trim()) {
        this.error(`Asset metadata ${metadata} must contain a non-empty uuid`);
      }
      return {
        code: `export default ${JSON.stringify(selectedMeta.uuid)};`,
        map: null,
      };
    },
  };
}
