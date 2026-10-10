import { isAbsolute, relative, sep } from 'node:path';

/** Whether a path is a strict descendant of a directory; the directory itself is excluded. */
export function isPathInside(directory: string, path: string): boolean {
  const relativePath = relative(directory, path);
  return relativePath !== ''
    && relativePath !== '..'
    && !relativePath.startsWith(`..${sep}`)
    && !isAbsolute(relativePath);
}
