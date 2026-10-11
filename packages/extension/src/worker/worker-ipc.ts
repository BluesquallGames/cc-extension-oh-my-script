// @ts-expect-error Creator injects ccWorker into the extension worker's global scope.
export const CreatorWorker = (globalThis.ccWorker) as unknown as {
  Ipc: {
    on(messageName: string, listener: (event: {
      reply(error: unknown, result?: unknown): void;
    }) => void, ...args: unknown[]): void;
  };
};
