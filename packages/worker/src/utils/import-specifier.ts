import { relative } from 'node:path';

export function makeFileSystemRelativeImportSpecifier(from: string, to: string) {
  let path = relative(from, to).replace(/\\/g, '/');
  if (path.startsWith('./')) {
    path = './' + path;
  }
  return path;
}

export function makeFileSystemAbsoluteImportSpecifier(file: string) {
  return file.replace(/\\/g, '/');
}
