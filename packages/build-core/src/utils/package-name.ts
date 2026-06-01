export function getBarePackageName(source: string) {
  if (
    source.length === 0
    || source.startsWith('.')
    || source.startsWith('/')
    || source.startsWith('\\')
    || source.includes('\0')
    || /^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(source)
  ) {
    return undefined;
  }
  const segments = source.split('/');
  if (source.startsWith('@')) {
    const [scope, name] = segments;
    if (!scope || !name) {
      return undefined;
    }
    return `${scope}/${name}`;
  }
  return segments[0] || undefined;
}
