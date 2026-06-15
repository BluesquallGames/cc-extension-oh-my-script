import type { Plugin } from 'rollup';
import { join } from 'node:path';
import { logger } from '../logger.js';
import { getBarePackageName } from '../utils/package-name.js';

const OMS_PEER_IMPORT_PREFIX = '#oms-peer:';
const PROJECT_PEER_IMPORTER = '__oms_project_peer_import_resolver__.js';

export function rollupPluginProjectPeerImports({
  projectPeers,
  projectRoot,
}: {
  projectPeers: string[];
  projectRoot: string | undefined;
}): Plugin {
  const projectPeerSet = new Set(projectPeers);

  return {
    name: 'oms:project-peer-imports',

    async resolveId(source, _importer, options) {
      if (!source.startsWith(OMS_PEER_IMPORT_PREFIX)) {
        return null;
      }
      if (!projectRoot) {
        this.error(`OMS peer import ${source} requires a project root`);
      }

      const projectPeerSource = source.slice(OMS_PEER_IMPORT_PREFIX.length);
      const packageName = getBarePackageName(projectPeerSource);
      if (!packageName) {
        this.error(`OMS peer import ${source} should reference a bare package specifier`);
      }
      if (!projectPeerSet.has(packageName)) {
        this.error(`OMS peer import ${source} is not allowed. Add ${packageName} to resolve.projectPeers in the project oms.config.*`);
      }

      const projectImporter = join(projectRoot, PROJECT_PEER_IMPORTER);
      const resolved = await this.resolve(projectPeerSource, projectImporter, {
        ...options,
        skipSelf: true,
      });
      if (resolved && !resolved.external && resolved.id !== projectPeerSource) {
        logger.debug(`Resolved OMS peer import ${source} from project root: ${resolved.id}`);
        return resolved;
      }

      this.error(`Failed to resolve OMS peer import ${source} from the project root. Install ${packageName} in the project or remove it from resolve.projectPeers`);
    },
  };
}
