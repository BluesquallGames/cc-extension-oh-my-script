import { selfPackageName } from '../self-info.js';
import { type WorkerMessageId, type WorkerMessageSignature } from '../worker/worker-message-descriptions.js';

export async function requestSelfWorkerMessage<TMessageId extends WorkerMessageId>(messageId: TMessageId, ...args: Parameters<WorkerMessageSignature<TMessageId>>) {
  return Editor.Message.request(selfPackageName, messageId, ...args);
}
