import { afterEach, expect, it } from 'vitest';
import fs from 'fs-extra';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { OmsBuilder } from '../src/oms-builder.js';
import { ServerContext } from '../src/server-context.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => fs.remove(dir)));
  tempDirs.length = 0;
});

it('does not emit passive-build-end when a pending passive build is claimed by an active build', async () => {
  const project = await makeTempDir();
  await fs.ensureDir(join(project, 'src'));
  const ctx = new ServerContext({
    invoke: async () => undefined,
  } as any);
  const builder = new OmsBuilder(ctx, {
    project,
  });

  try {
    await builder.rebuild({
      extensionBuildOptions: [],
    });

    const watcher = (builder as any)._watcher;
    expect(watcher).toBeTruthy();

    let unblock!: () => void;
    const blocker = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const blockTask = watcher._taskQueue.queueTask({
      type: 'inlineUUIDs',
      exec: async () => {
        await blocker;
      },
    });

    let passiveBuildEndCount = 0;
    builder.on('passive-build-end', () => {
      passiveBuildEndCount++;
    });

    watcher._queuePassiveBuild('test passive build');
    const activeBuild = watcher.build();
    unblock();

    await blockTask;
    await expect(activeBuild).resolves.toMatchObject({
      ok: true,
    });
    await setTimeout(50);

    expect(passiveBuildEndCount).toBe(0);
  } finally {
    await (builder as any)._clean();
  }
});

async function makeTempDir() {
  const dir = await fs.mkdtemp(join(tmpdir(), 'oms-builder-'));
  tempDirs.push(dir);
  return dir;
}
