import { type OmsBuilderAgent } from './oms-builder-agent.js';
import type {
  BuildProfileId,
  BuildProfileResult,
  BuildProfileResults,
} from '@oms/build-core/protocol';

export interface WorkerMessageDescription<TSignature extends (...args: never[]) => unknown> {
  readonly signature?: TSignature;
}

function defineWorkerMessage<TSignature extends (...args: never[]) => unknown>() {
  return {
  } as WorkerMessageDescription<TSignature>;
}

export interface RebuildOptions {
  reason?: string;
  reloadAssetDbRuntime?: boolean;
  reloadSceneRuntime?: boolean;
  profiles?: BuildProfileId[];
}

export const workerMessageDescriptions = {
  'rebuild': defineWorkerMessage<(opts?: RebuildOptions) => Promise<BuildProfileResults>>(),
  'ensure-default-profile': defineWorkerMessage<() => Promise<BuildProfileResult>>(),
  'restart': defineWorkerMessage<OmsBuilderAgent['restart']>(),
  'inline-uuids': defineWorkerMessage<OmsBuilderAgent['inlineUUIDs']>(),
  'build-prod': defineWorkerMessage<OmsBuilderAgent['buildProd']>(),
} as const;

export type WorkerMessageId = keyof typeof workerMessageDescriptions;

export type WorkerMessageSignature<T extends WorkerMessageId>
  = (typeof workerMessageDescriptions)[T] extends WorkerMessageDescription<infer Signature>
    ? Signature
    : never;
