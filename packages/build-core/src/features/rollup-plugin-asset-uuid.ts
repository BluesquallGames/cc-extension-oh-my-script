import type { Plugin } from 'rollup';
import { dirname, isAbsolute, resolve } from 'node:path';
import { isPathInside } from '../utils/path.js';

const assetUUIDPrefix = '\0oms:asset-uuid:';
const assetUUIDQuerySuffix = '?uuid';

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
      if (!source.endsWith(assetUUIDQuerySuffix)) {
        return;
      }
      const specifier = source.slice(0, -assetUUIDQuerySuffix.length);
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
        id: assetUUIDPrefix + file,
        moduleSideEffects: false,
      };
    },

    async load(id) {
      if (!id.startsWith(assetUUIDPrefix)) {
        return;
      }
      const file = id.slice(assetUUIDPrefix.length);
      const metadata = `${file}.meta`;
      // Register before reading so missing assets and metadata can recover after creation.
      this.addWatchFile(file);
      this.addWatchFile(metadata);
      if (!(await this.fs.stat(file)).isFile()) {
        this.error(`Asset UUID import requires a file: ${file}`);
      }
      let meta: { uuid?: unknown };
      try {
        meta = JSON.parse(
          await this.fs.readFile(metadata, { encoding: 'utf8' }),
        ) as { uuid?: unknown };
      } catch (cause) {
        throw new Error(`Cannot read or parse asset metadata ${metadata}`, { cause });
      }
      if (typeof meta.uuid !== 'string' || !meta.uuid.trim()) {
        this.error(`Asset metadata ${metadata} must contain a non-empty uuid`);
      }
      return {
        code: `export default ${JSON.stringify(meta.uuid)};`,
        map: null,
      };
    },
  };
}
