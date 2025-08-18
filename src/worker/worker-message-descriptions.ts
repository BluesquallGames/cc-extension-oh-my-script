import { type OmsBuilderAgent } from './oms-builder-agent.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars, @typescript-eslint/no-empty-object-type
export interface WorkerMessageDescription<TSignature extends (...args: any) => any> {
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function defineWorkerMessage<TSignature extends (...args: any) => any>() {
  return {
  } as WorkerMessageDescription<TSignature>;
}

export const workerMessageDescriptions = {
  'rebuild': defineWorkerMessage<() => void>(),
  'restart': defineWorkerMessage<() => void>(),
  'inline-uuids': defineWorkerMessage<() => void>(),
  'build-prod': defineWorkerMessage<(opts: Parameters<OmsBuilderAgent['buildProd']>[0]) => void>(),
} as const;

export type WorkerMessageId = keyof typeof workerMessageDescriptions;

export type WorkerMessageSignature<T extends WorkerMessageId> =
  (typeof workerMessageDescriptions)[T] extends WorkerMessageDescription<infer Signature> ? Signature : never;
