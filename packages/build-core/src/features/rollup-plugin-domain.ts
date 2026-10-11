import type { Plugin } from 'rollup';
import type { Domain } from '../domain.js';

const domainModuleURLRegex = /^oms:\/\/([^/]+)(?:\/(.*))?$/;

export function rollupPluginDomain({
  domains,
  allowEditorOnlyImports,
}: {
  domains: Record<string, Domain>;
  allowEditorOnlyImports: boolean;
}): Plugin {
  return {
    name: 'oms:domain',

    resolveId(id) {
      const parsed = parseDomainModuleURL(id);
      if (!parsed) {
        return null;
      }
      const { domainId, exportSubpath } = parsed;
      const matchingDomains = Object.values(domains).filter((domain) => domain
        .exportPackageName === domainId);
      if (matchingDomains.length > 1) {
        return this.error(`Duplicate OMS export package name: ${domainId}`);
      }
      const domain = matchingDomains[0];
      if (!domain) {
        return this.error(`OMS export package ${domainId} not found`);
      }
      if (!allowEditorOnlyImports && domain.isEditorExport(exportSubpath)) {
        return this.error(`Editor-only OMS import ${id} is not available in production builds`);
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
