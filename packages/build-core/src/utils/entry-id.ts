export function makeOmsExportEntryId(domainId: string, exportId: string) {
  return `${domainId}:${exportId}`;
}

export function makeOmsEntryFileName(entryId: string) {
  const exportEntry = parseOmsExportEntryId(entryId);
  if (exportEntry) {
    return `exports/${exportEntry.domainId}/${exportEntry.exportId === '.' ? 'index' : exportEntry.exportId}`;
  }
  return entryId;
}

function parseOmsExportEntryId(entryId: string) {
  const iColon = entryId.indexOf(':');
  if (iColon < 0) {
    return undefined;
  }
  const domainId = entryId.slice(0, iColon);
  const exportId = entryId.slice(iColon + 1);
  if (!domainId || !exportId) {
    return undefined;
  }
  return {
    domainId,
    exportId,
  };
}
