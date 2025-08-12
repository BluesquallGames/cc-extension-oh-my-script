import { type Serializable } from "node:child_process";
import { logger } from "./logger.js";

export interface ClientInvocationMap {
  'setup': (options: {
    project: string;
  }) => void;

  'rebuild': () => void;
}

export type ClientInvocationMethodId = keyof ClientInvocationMap;

export interface ServerInvocationMap {
  'bootstrapped': () => void;

  'build-success': (changes: {
    affectedFiles: string[];
  }) => void;

  'build-failed': (error: {}) => void;
}

export type ServerInvocationMethodId = keyof ServerInvocationMap;

export type InvocationMap = ClientInvocationMap & ServerInvocationMap;

export type InvocationMethodId = keyof InvocationMap;

export type InvocationParams<T extends InvocationMethodId> = Parameters<InvocationMap[T]>[0];

export type InvocationReturnValue<T extends InvocationMethodId> = InvocationMap[T] extends () => Promise<infer R> ? R : void;

export enum InvocationDirection {
  call = 'call',
  returns = 'returns',
}

export type InvocationError = {
  message: string;
  stack?: string;
}

export type InvocationResultMessage<T extends InvocationMethodId> = {
  direction: InvocationDirection.returns;
  invocationId: number;
  ok: true;
  returnValue: InvocationReturnValue<T>;
} | {
  direction: InvocationDirection.returns;
  invocationId: number;
  ok: false;
  error: InvocationError;
};

export interface InvocationCallMessage<T extends InvocationMethodId = InvocationMethodId> {
  direction: InvocationDirection.call;
  invocationId: number;
  method: T;
  args: InvocationParams<T>;
}

export type InvocationMessage<T extends InvocationMethodId = InvocationMethodId> = InvocationCallMessage<T> | InvocationResultMessage<T>;

export interface IpcTransport {
  send<T extends InvocationMethodId>(message: InvocationMessage<T>): void;
}

export class Ipc<
  TOutgoingMessageId extends InvocationMethodId = InvocationMethodId,
  TIncomingMessageId extends InvocationMethodId = InvocationMethodId,
> {
  constructor(
    private _transport: IpcTransport,
  ) {
  }

  dispatch<T extends InvocationMethodId>(message: InvocationMessage<T>) {
    if (message.direction === InvocationDirection.call) {
      this._handleCall(message as unknown as InvocationCallMessage<TIncomingMessageId>);
    } else if (message.direction === InvocationDirection.returns) {
      this._handleReturns(message as unknown as InvocationResultMessage<TOutgoingMessageId>);
    }
  }

  listen<T extends TIncomingMessageId>(methodId: T, callback: (args: InvocationParams<T>) => (Serializable | undefined | void) | Promise<Serializable | undefined | void>) {
    if (this._listeners.has(methodId)) {
      logger.error(`Listener for method ${methodId} already exists`);
      return;
    }
    this._listeners.set(methodId, callback);
  }

  invoke<T extends TOutgoingMessageId>(methodId: T, args: InvocationParams<T>): Promise<InvocationReturnValue<T>> {
    const invocationId = this._nextInvocationId++;
    const message: InvocationCallMessage<T> = {
      direction: InvocationDirection.call,
      invocationId,
      method: methodId,
      args,
    };
    logger.debug(`Sending message: ${JSON.stringify(message)}`);
    this._transport.send(message);
    return new Promise<InvocationReturnValue<T>>((resolve, reject) => {
      this._invocations.set(invocationId, (response: InvocationResultMessage<TOutgoingMessageId>) => {
        this._invocations.delete(invocationId);
        if (response.ok) {
          resolve(response.returnValue as InvocationReturnValue<T>);
        } else {
          reject(new Error(`Invocation ${invocationId} failed: ${stringifyResponseError(response.error)}`));
        }
      });
    });
  }

  private _nextInvocationId = 0;
  private _invocations: Map<number, (response: InvocationResultMessage<TOutgoingMessageId>) => void> = new Map();
  private _listeners: Map<TIncomingMessageId, (args: InvocationParams<TIncomingMessageId>) => Serializable | undefined | void | Promise<Serializable | undefined | void>> = new Map();

  private _sendInvocationResult<T extends TIncomingMessageId>(invocationId: number, result: InvocationResultMessage<T>) {
    this._transport.send(result);
  }

  private _handleCall<T extends TIncomingMessageId>(message: InvocationCallMessage<T>) {
    const listener = this._listeners.get(message.method);
    if (!listener) {
      this._sendInvocationResult(message.invocationId, {
        direction: InvocationDirection.returns,
        invocationId: message.invocationId,
        ok: false,
        error: {
          message: `No handler for message type ${message.method}`,
        },
      });
    } else {
      try {
        const result = listener(message.args);
        if (result instanceof Promise) {
          result.then((returnValue) => {
            this._sendInvocationResult(message.invocationId, {
              direction: InvocationDirection.returns,
              invocationId: message.invocationId,
              ok: true,
              returnValue: returnValue as InvocationReturnValue<T>,
            });
          }).catch((error) => {
            this._sendInvocationResult(message.invocationId, {
              direction: InvocationDirection.returns,
              invocationId: message.invocationId,
              ok: false,
              error: errorToInvocationError(error),
            });
          });
        } else {
          this._sendInvocationResult(message.invocationId, {
            direction: InvocationDirection.returns,
            invocationId: message.invocationId,
            ok: true,
            returnValue: result as InvocationReturnValue<T>,
          });
        }
      } catch (error) {
        this._sendInvocationResult(message.invocationId, {
          direction: InvocationDirection.returns,
          invocationId: message.invocationId,
          ok: false,
          error: errorToInvocationError(error),
        });
      }
    }
  }

  private _handleReturns<T extends TOutgoingMessageId>(message: InvocationResultMessage<T>) {
    const invocation = this._invocations.get(message.invocationId);
    if (!invocation) {
      logger.error(`Unknown invocation ${message.invocationId}`);
      return;
    }
    this._invocations.delete(message.invocationId);
    try {
      invocation(message as InvocationResultMessage<TOutgoingMessageId>);
    } catch (error) {
      logger.error(`Error handling invocation ${message.invocationId}: ${error}`);
    }
  }
}

function stringifyResponseError(error: InvocationError) {
  let text = '';
  if (error.message) {
    text += error.message;
  }
  if (error.stack) {
    text += `\n${error.stack}`;
  }
  return text;
}

function errorToInvocationError(error: unknown): InvocationError {
  let message = '';
  let stack: string | undefined = undefined;
  if (typeof error === 'string') {
    message = error;
  } else if (error instanceof Error) {
    message = error.message;
    stack = error.stack;
  } else if (typeof error === 'symbol') {
    message = `Symbol [${error.description}]`;
  } else if (typeof error === 'bigint') {
    message = `BigInt [${error}]`;
  } else {
    try {
      message = JSON.stringify(error);
    } catch (err) {
      message = 'unknown';
    }
  }
  return {
    message,
    stack,
  };
}
