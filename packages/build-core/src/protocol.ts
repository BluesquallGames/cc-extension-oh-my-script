import { type Serializable } from 'node:child_process';
import { logger } from './logger.js';

export { setLogger } from './logger.js';

export enum BuildProfileId {
  default = 'default',
  headless = 'headless',
}

export const allBuildProfileIds: BuildProfileId[] = [
  BuildProfileId.default,
  BuildProfileId.headless,
];

export type BuildProfileResult = {
  ok: true;
  affectedFiles: string[];
} | {
  ok: false;
  error: {
    message: string;
    stack?: string;
  };
};

export type BuildProfileResults = Partial<Record<BuildProfileId, BuildProfileResult>>;

export interface ClientInvocationMap {
  'setup': (options: {
    project: string;
  }) => void;

  'rebuild': (opts: RebuildOptions) => BuildProfileResults;

  'clean-rebuild': (opts: RebuildOptions) => BuildProfileResults;

  'inline-uuids': () => void;

  'build-prod': (opts: {
    buildDir: string;
    debug: boolean;
    sourceMaps: boolean | 'inline';
    platform: string;
    headless: boolean;
  }) => void;

  'update-build-options': (options: BuildOptions) => void;

  'ping': () => void;
}

export interface BuildOptions {
  extensionBuildOptions: ExtensionBuildOptions[];
}

export interface RebuildOptions {
  profiles?: BuildProfileId[];
}

export interface ExtensionBuildOptions {
  name: string;
  path: string;
}

export type ClientInvocationMethodId = keyof ClientInvocationMap;

export interface PassiveBuildEndInfo {
  profileResults: Record<BuildProfileId, BuildProfileResult>;
}

export interface PassiveProfileBuildEndInfo {
  profile: BuildProfileId;
  result: BuildProfileResult;
}

export interface BuildStartInfo {
  time: number;
  profiles: BuildProfileId[];
}

export interface ServerInvocationMap {
  'bootstrapped': () => void;

  'pong': () => void;

  'passive-build-end': (info: PassiveBuildEndInfo) => void;

  'passive-profile-build-end': (info: PassiveProfileBuildEndInfo) => void;

  'build-start': (state: BuildStartInfo) => void;

  'build-end': (state: {
    time: number;
    startState: BuildStartInfo;
  }) => void;
}

export type ServerInvocationMethodId = keyof ServerInvocationMap;

export type InvocationMap = ClientInvocationMap & ServerInvocationMap;

export type InvocationMethodId = keyof InvocationMap;

export type InvocationParams<T extends InvocationMethodId> = Parameters<InvocationMap[T]>[0];

export type InvocationReturnValue<T extends InvocationMethodId>
  = Awaited<ReturnType<InvocationMap[T]>>;

export enum InvocationDirection {
  call = 'call',
  returns = 'returns',
}

export interface InvocationError {
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

export type InvocationMessage<T extends InvocationMethodId = InvocationMethodId>
  = InvocationCallMessage<T> | InvocationResultMessage<T>;

export interface IpcTransport {
  send<T extends InvocationMethodId>(message: InvocationMessage<T>): void;
}

export class InvocationFailed extends Error {
  constructor(response: Extract<InvocationResultMessage<InvocationMethodId>, { ok: false }>) {
    super(stringifyResponseError(response.error));
    this._responseStack = response.error.stack;
  }

  get responseStack() {
    return this._responseStack;
  }

  private _responseStack: string | undefined;
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
    if (this._closedError) {
      return;
    }
    if (message.direction === InvocationDirection.call) {
      this._handleCall(message as unknown as InvocationCallMessage<TIncomingMessageId>);
    } else if (message.direction === InvocationDirection.returns) {
      this._handleReturns(message as unknown as InvocationResultMessage<TOutgoingMessageId>);
    }
  }

  listen<T extends TIncomingMessageId>(
    methodId: T,
    callback: (args: InvocationParams<T>) => Serializable | undefined | void
      | Promise<Serializable | undefined | void>,
  ) {
    if (this._listeners.has(methodId)) {
      logger.error(`Listener for method ${methodId} already exists`);
      return;
    }
    this._listeners.set(methodId, callback);
  }

  invoke<T extends TOutgoingMessageId>(
    methodId: T,
    args: InvocationParams<T>,
  ): Promise<InvocationReturnValue<T>> {
    if (this._closedError) {
      return Promise.reject(this._closedError);
    }
    const invocationId = this._nextInvocationId++;
    const message: InvocationCallMessage<T> = {
      direction: InvocationDirection.call,
      invocationId,
      method: methodId,
      args,
    };
    return new Promise<InvocationReturnValue<T>>((resolve, reject) => {
      this._invocations.set(invocationId, {
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      try {
        // logger.debug(`Sending message: ${JSON.stringify(message)}`);
        this._transport.send(message);
      } catch (error) {
        this._invocations.delete(invocationId);
        // Preserve the transport's original rejection value for the caller.
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        reject(error);
      }
    });
  }

  close(reason: string) {
    if (this._closedError) {
      return;
    }
    const error = new Error(reason);
    this._closedError = error;
    for (const invocation of this._invocations.values()) {
      invocation.reject(error);
    }
    this._invocations.clear();
    this._listeners.clear();
  }

  private _nextInvocationId = 0;
  private _invocations = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (reason?: unknown) => void;
  }>();

  private _listeners = new Map<
    TIncomingMessageId,
    (args: InvocationParams<TIncomingMessageId>) => Serializable | undefined | void
      | Promise<Serializable | undefined | void>
  >();

  private _closedError: Error | undefined;

  private _sendInvocationResult<T extends TIncomingMessageId>(_invocationId: number,
    result: InvocationResultMessage<T>) {
    if (this._closedError) {
      return;
    }
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
    if (message.ok) {
      invocation.resolve(message.returnValue);
    } else {
      invocation.reject(new InvocationFailed(message));
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
  let message: string;
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
    } catch (_err) {
      message = 'unknown';
    }
  }
  return {
    message,
    stack,
  };
}
