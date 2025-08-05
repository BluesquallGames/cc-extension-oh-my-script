export const CreatorWorker = (globalThis.ccWorker) as unknown as {
  Ipc: {
    on(messageName: string, listener: (event: {
      reply(error: unknown | null, result?: unknown): void;
    }) => void, ...args: unknown[]): void;
  };
};
