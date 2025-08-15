import { HTML5, PREVIEW, EDITOR } from 'cc/env';

export async function load(id: string, parent: string) {
  let specifier = id;
  if (EDITOR) {
    const r = require;
    specifier = r('url').pathToFileURL(r('path').join(Editor.Project.tmpDir, 'oms/out', id)).href;
  } else if (HTML5 && PREVIEW) {
    specifier = `/oms/${id}`;
  }
  const resolved = await import.meta.resolve(specifier, parent);
  await import(resolved);
}
