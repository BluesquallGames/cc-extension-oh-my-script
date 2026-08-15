import fs from 'fs-extra';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { registerMessageHandlers } from '../src/message-handlers.js';
import { Ipc, type ClientInvocationMethodId, type InvocationMessage, type ServerInvocationMethodId } from '../src/protocol.js';
import { ServerContext } from '../src/server-context.js';
import { logger } from '../src/logger.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => fs.remove(dir)));
  tempDirs.length = 0;
});

it('delivers passive profile completion over IPC before the full revision ends', async () => {
  /// @case
  /// 1. A real watcher builds default and headless profiles through registered IPC message handlers.
  /// 2. A source touch starts a passive revision whose headless bundle is substantially larger than default.
  /// @expect
  /// The client receives both passive profile completions before build-end and passive-build-end.
  const project = await fs.mkdtemp(join(tmpdir(), 'oms-message-handlers-'));
  tempDirs.push(project);
  const runtimeEntry = join(project, 'src', 'index.ts');
  await fs.outputFile(join(project, 'oms.config.mjs'), [
    'export default {',
    '  profiles: {',
    '    headless: { include: ["src/**/*.headless.ts"] },',
    '  },',
    '};',
  ].join('\n'));
  await fs.outputFile(runtimeEntry, 'export const marker = "before-ipc-runtime-end";');
  await fs.outputFile(join(project, 'src', 'index.headless.ts'), 'export { values } from "./headless-heavy";');
  await fs.outputFile(join(project, 'src', 'headless-heavy.ts'), [
    'export const values = [',
    Array.from({ length: 50_000 }, (_, index) => `${index},`).join(''),
    '];',
  ].join('\n'));

  let serverIpc!: Ipc<ServerInvocationMethodId, ClientInvocationMethodId>;
  const clientIpc = new Ipc<ClientInvocationMethodId, ServerInvocationMethodId>({
    send: (message) => serverIpc.dispatch(message as InvocationMessage),
  });
  serverIpc = new Ipc<ServerInvocationMethodId, ClientInvocationMethodId>({
    send: (message) => clientIpc.dispatch(message as InvocationMessage),
  });
  const registry = registerMessageHandlers(new ServerContext(serverIpc));
  const initialBuildEnd = deferred<void>();
  const passiveBuildEnd = deferred<void>();
  const passiveMessages: string[] = [];
  let passivePhase = false;
  const logError = vi.spyOn(logger, 'error').mockImplementation(() => logger);

  clientIpc.listen('build-start', () => undefined);
  clientIpc.listen('passive-profile-build-end', ({ profile, result }) => {
    if (passivePhase) {
      expect(result).toMatchObject({ ok: true });
      passiveMessages.push(`passive-profile-build-end:${profile}`);
      if (profile === 'default') {
        throw new Error('passive receiver failed');
      }
    }
  });
  clientIpc.listen('build-end', () => {
    if (passivePhase) {
      passiveMessages.push('build-end');
    } else {
      initialBuildEnd.resolve();
    }
  });
  clientIpc.listen('passive-build-end', () => {
    passiveMessages.push('passive-build-end');
    passiveBuildEnd.resolve();
  });

  try {
    await clientIpc.invoke('setup', { project });
    await clientIpc.invoke('update-build-options', { extensionBuildOptions: [] });
    await expect(clientIpc.invoke('rebuild', { profiles: ['default'] })).resolves.toMatchObject({
      default: { ok: true },
    });
    await initialBuildEnd.promise;

    const staleOutput = join(project, 'temp', 'oms', 'out', 'stale-output.js');
    await fs.outputFile(staleOutput, 'stale');
    await expect(clientIpc.invoke('clean-rebuild', {})).resolves.toMatchObject({
      default: { ok: true },
      headless: { ok: true },
    });
    expect(await fs.pathExists(staleOutput)).toBe(false);

    passivePhase = true;
    await fs.outputFile(runtimeEntry, 'export const marker = "after-ipc-runtime-end";');
    await expect(withTimeout(passiveBuildEnd.promise, 10_000)).resolves.toBeUndefined();
    await vi.waitFor(() => {
      expect(logError).toHaveBeenCalledWith(
        'Failed to deliver passive default profile build result: %o',
        expect.objectContaining({ message: expect.stringContaining('passive receiver failed') }),
      );
    });

    expect(passiveMessages).toEqual([
      'passive-profile-build-end:default',
      'passive-profile-build-end:headless',
      'build-end',
      'passive-build-end',
    ]);
  } finally {
    logError.mockRestore();
    await registry.close();
    clientIpc.close('test cleanup');
    serverIpc.close('test cleanup');
  }
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}
