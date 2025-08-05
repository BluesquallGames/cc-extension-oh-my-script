export interface InvocationMap {
  setup: (options: {
    project: string;
  }) => void;

  rebuild: () => void;
}

export type InvocationMethodId = keyof InvocationMap;

export type InvocationParams<T extends InvocationMethodId> = Parameters<InvocationMap[T]>[0];

export type InvocationReturnValue<T extends InvocationMethodId> = InvocationMap[T] extends () => Promise<infer R> ? R : void;

export type InvocationResult<T extends InvocationMethodId> = {
  invocationId: number;
  ok: true;
  returnValue: InvocationReturnValue<T>;
} | {
  invocationId: number;
  ok: false;
  error: unknown;
};

export interface InvocationMessage<T extends InvocationMethodId = InvocationMethodId> {
  invocationId: number;
  method: T;
  args: InvocationParams<T>;
}
