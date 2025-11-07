import type { Plugin } from 'rollup';
import type { Domain } from '../domain.js';

const domainModuleURLRegex = /^oms:\/\/([^\/]+)(?:\/(.*))?$/;

export function rollupPluginDomain({
  domains,
}: {
  domains: Record<string, Domain>,
}): Plugin {
  return {
    name: 'oms:domain',

    async resolveId(id) {
      const parsed = parseDomainModuleURL(id);
      if (!parsed) {
        return null;
      }
      const { domainId, exportSubpath } = parsed;
      const domain = domains[domainId];
      if (!domain) {
        return this.error(`Domain ${domainId} not found`);
      }
      const exportPathResolved = domain.resolveExport(exportSubpath);
      if (!exportPathResolved) {
        return this.error(`Export ${exportSubpath} not found in domain ${domainId}`);
      }
      return exportPathResolved;
    },
  };
}

function parseDomainModuleURL(id: string) {
  const match = domainModuleURLRegex.exec(id);
  if (!match) {
    return undefined;
  }
  return {
    domainId: match[1],
    exportSubpath: match[2] || '.',
  };
}
