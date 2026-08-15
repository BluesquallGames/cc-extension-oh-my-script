import { selfExtensionName } from './self-info.js';
import type { BuildProfileId } from '@oms/build-core/protocol';

export enum InnerPackageMessageId {
  buildStart = 'build-start',
  buildEnd = 'build-end',
}

interface InnerPackageMessageMap {
  [InnerPackageMessageId.buildStart]: [{
    time: number;
    profiles: BuildProfileId[];
  }];
  [InnerPackageMessageId.buildEnd]: [{
    time: number;
    startState: {
      time: number;
      profiles: BuildProfileId[];
    };
  }];
}

export type InnerPackageMessageArgs<TMessageId extends keyof InnerPackageMessageMap> = InnerPackageMessageMap[TMessageId];

export function broadcastInner<TMessageId extends keyof InnerPackageMessageMap>(messageId: TMessageId, ...args: InnerPackageMessageArgs<TMessageId>) {
  Editor.Message.broadcast(`${selfExtensionName}:${messageId}`, ...args);
}

export function addInnerPackageMessageListener<TMessageId extends keyof InnerPackageMessageMap>(messageId: TMessageId, callback: (...args: InnerPackageMessageArgs<TMessageId>) => void, opts?: { signal?: AbortSignal }) {
  const messageIdNormalized = `${selfExtensionName}:${messageId}`;
  Editor.Message.__protected__.addBroadcastListener(messageIdNormalized, callback);
  if (opts?.signal) {
    opts.signal.addEventListener('abort', () => {
      Editor.Message.__protected__.removeBroadcastListener(messageIdNormalized, callback);
    });
  }
}
