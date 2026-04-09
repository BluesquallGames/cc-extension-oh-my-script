import { selfExtensionName } from './self-info.js';

export enum InnerPackageMessageId {
  buildStart = 'build-start',
  buildEnd = 'build-end',
}

interface InnerPackageMessageMap {
  [InnerPackageMessageId.buildStart]: [{
    time: number;
  }];
  [InnerPackageMessageId.buildEnd]: [{
    time: number;
    startState: {
      time: number;
    };
  }];
}

export type InnerPackageMessageArgs<TMessageId extends keyof InnerPackageMessageMap> = InnerPackageMessageMap[TMessageId];

export function broadcastInner<TMessageId extends keyof InnerPackageMessageMap>(messageId: TMessageId, ...args: InnerPackageMessageArgs<TMessageId>) {
  Editor.Message.broadcast(`${selfExtensionName}:${messageId}`, ...args);
}

declare global {
  namespace Editor {
    namespace Message {
      namespace __protected__ {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        function addBroadcastListener(id: string, callback: (...args: any[]) => void): void;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        function removeBroadcastListener(id: string, callback: (...args: any[]) => void): void;
      }
    }
  }
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
