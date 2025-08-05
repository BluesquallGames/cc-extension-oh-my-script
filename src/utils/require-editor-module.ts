import { createRequire } from 'node:module';
import { resolve } from 'node:path';
module.paths.push(resolve(Editor.App.path, 'node_modules'));

export function requireEditorModule<T>(moduleName: string): T {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(moduleName);
}

export const requireEditorModule2 = createRequire(resolve(Editor.App.path, 'index.js'));
