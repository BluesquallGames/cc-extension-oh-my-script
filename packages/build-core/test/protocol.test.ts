import { describe, expect, it, vi } from 'vitest';
import { Ipc } from '../src/protocol.js';

describe('Ipc lifecycle', () => {
  it('rejects pending invocations when the transport closes', async () => {
    /// @case
    /// An invocation is waiting for a response when its process transport closes.
    /// @expect
    /// The invocation rejects with the close reason instead of remaining pending forever.
    const ipc = new Ipc({ send: vi.fn() });
    const invocation = ipc.invoke('rebuild', {});

    ipc.close('worker exited');

    await expect(invocation).rejects.toThrow('worker exited');
  });

  it('rejects new invocations after close without sending them', async () => {
    /// @case
    /// A caller invokes a method after its IPC transport has already closed.
    /// @expect
    /// The call rejects immediately and no message is sent through the dead transport.
    const send = vi.fn();
    const ipc = new Ipc({ send });
    ipc.close('worker exited');

    await expect(ipc.invoke('rebuild', {})).rejects.toThrow('worker exited');
    expect(send).not.toHaveBeenCalled();
  });
});
