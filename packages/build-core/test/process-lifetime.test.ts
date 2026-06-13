import { afterEach, expect, it, vi } from 'vitest';
import { installProcessDisconnectShutdown } from '../src/process-lifetime.js';

const originalProcessConnectedDescriptor = Object.getOwnPropertyDescriptor(process, 'connected');

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (originalProcessConnectedDescriptor) {
    Object.defineProperty(process, 'connected', originalProcessConnectedDescriptor);
  } else {
    delete (process as { connected?: boolean }).connected;
  }
});

it('exits after cleaning up when the IPC channel disconnects', async () => {
  /// @case
  /// 1. The OMS build-core process has an IPC channel to its parent.
  /// 2. The parent process goes away and Node emits `disconnect`.
  /// @expect
  /// The child process runs cleanup and exits successfully.
  const { disconnect, exit } = mockProcessLifetime();
  const cleanup = vi.fn(async () => undefined);

  installProcessDisconnectShutdown({
    cleanup,
  });

  disconnect();
  await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));

  expect(cleanup).toHaveBeenCalledTimes(1);
});

it('still exits when disconnect cleanup fails', async () => {
  /// @case
  /// 1. The parent IPC channel disconnects.
  /// 2. Cleanup throws while releasing OMS resources.
  /// @expect
  /// The child process still exits instead of staying alive as an orphan.
  const { disconnect, exit } = mockProcessLifetime();
  const cleanup = vi.fn(async () => {
    throw new Error('cleanup failed');
  });

  installProcessDisconnectShutdown({
    cleanup,
  });

  disconnect();
  await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));

  expect(cleanup).toHaveBeenCalledTimes(1);
});

it('forces exit when disconnect cleanup never settles', async () => {
  /// @case
  /// 1. The parent IPC channel disconnects.
  /// 2. Cleanup hangs while closing long-lived resources.
  /// @expect
  /// The child still exits after the disconnect cleanup timeout.
  vi.useFakeTimers();
  const { disconnect, exit } = mockProcessLifetime();
  const cleanup = vi.fn(() => new Promise<void>(() => undefined));

  installProcessDisconnectShutdown({
    cleanup,
  });

  disconnect();
  await vi.advanceTimersByTimeAsync(10_000);

  expect(exit).toHaveBeenCalledWith(0);
  expect(cleanup).toHaveBeenCalledTimes(1);
});

it('shuts down immediately if the IPC channel is already disconnected', async () => {
  /// @case
  /// 1. build-core installs its process lifetime handler after the parent IPC channel is already closed.
  /// 2. No future `disconnect` event is guaranteed.
  /// @expect
  /// The child still runs cleanup and exits.
  const { exit } = mockProcessLifetime();
  setProcessConnected(false);
  const cleanup = vi.fn(async () => undefined);

  installProcessDisconnectShutdown({
    cleanup,
  });

  await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));

  expect(cleanup).toHaveBeenCalledTimes(1);
});

function mockProcessLifetime() {
  let disconnect: (() => void) | undefined;
  vi.spyOn(process, 'once').mockImplementation(((event, listener) => {
    if (event === 'disconnect') {
      disconnect = listener as () => void;
      return process;
    }
    return process.once(event, listener);
  }) as typeof process.once);
  const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined as never) as typeof process.exit);

  return {
    disconnect() {
      expect(disconnect).toBeDefined();
      disconnect?.();
    },
    exit,
  };
}

function setProcessConnected(connected: boolean) {
  Object.defineProperty(process, 'connected', {
    configurable: true,
    value: connected,
  });
}
