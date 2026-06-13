import process from 'node:process';

interface ProcessDisconnectShutdownOptions {
  cleanup: () => void | Promise<void>;
}

const disconnectCleanupTimeoutMs = 5_000;

export function installProcessDisconnectShutdown(
  options: ProcessDisconnectShutdownOptions,
) {
  let shutdownPromise: Promise<void> | undefined;

  const shutdown = async () => {
    if (shutdownPromise) {
      return await shutdownPromise;
    }
    shutdownPromise = (async () => {
      const forceExitTimer = setTimeout(() => {
        process.exit(0);
      }, disconnectCleanupTimeoutMs);
      forceExitTimer.unref();
      try {
        await options.cleanup();
      } catch {
        // Cleanup must never keep an orphaned build-core process alive.
      } finally {
        clearTimeout(forceExitTimer);
        process.exit(0);
      }
    })();
    return await shutdownPromise;
  };

  process.once('disconnect', () => {
    void shutdown();
  });
  if (process.connected === false) {
    void shutdown();
  }
}
