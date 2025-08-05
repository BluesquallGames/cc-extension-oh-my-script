export type RecursivePartial<T> = {
  [P in keyof T]?: RecursivePartial<T[P]>;
};

export function objectAssignDeep<T>(target: T, source: RecursivePartial<T>) {
  for (const [k, v] of (Object.entries(source) as Array<[keyof T, T[keyof T]]>)) {
    if (typeof v === 'object' && v) {
      objectAssignDeep(target[k] ??= (Array.isArray(v) ? [] : {}) as T[typeof k], v);
    } else {
      target[k] = v;
    }
  }
  return target;
}
