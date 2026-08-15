import { expect, it } from 'vitest';
import { TaskQueue } from '../src/task-queue.js';

it('rejects pending tasks when the queue aborts', async () => {
  /// @case
  /// 1. One task is running while a different task remains pending.
  /// 2. The queue aborts before the pending task starts.
  /// @expect
  /// The pending caller rejects immediately, while the running task settles only after its executor actually finishes.
  let releaseRunningTask!: () => void;
  const runningTaskBlocker = new Promise<void>((resolve) => {
    releaseRunningTask = resolve;
  });
  const queue = new TaskQueue<{
    running: () => string;
    pending: () => string;
  }>();
  const runningTask = queue.queueTask({
    type: 'running',
    exec: async () => {
      await runningTaskBlocker;
      return 'running finished';
    },
  });
  const pendingTask = queue.queueTask({
    type: 'pending',
    exec: async () => 'pending finished',
  });

  const pendingRejection = expect(pendingTask).rejects.toThrow('Task queue aborted');
  const abortPromise = queue.abort();
  await pendingRejection;

  let runningSettled = false;
  void runningTask.finally(() => {
    runningSettled = true;
  });
  await Promise.resolve();
  expect(runningSettled).toBe(false);

  releaseRunningTask();
  await expect(runningTask).resolves.toBe('running finished');
  await abortPromise;
});

it('rejects later tasks from the active execution batch when the queue aborts', async () => {
  /// @case
  /// 1. Three distinct tasks are queued, and the second starts after the first finishes.
  /// 2. The queue aborts while the second task is running.
  /// @expect
  /// The third task rejects without executing, while the second still settles only when its executor finishes.
  let releaseFirstTask!: () => void;
  const firstTaskBlocker = new Promise<void>((resolve) => {
    releaseFirstTask = resolve;
  });
  let releaseSecondTask!: () => void;
  const secondTaskBlocker = new Promise<void>((resolve) => {
    releaseSecondTask = resolve;
  });
  let markSecondTaskStarted!: () => void;
  const secondTaskStarted = new Promise<void>((resolve) => {
    markSecondTaskStarted = resolve;
  });
  const executions: string[] = [];
  const queue = new TaskQueue<{
    first: () => void;
    second: () => void;
    third: () => void;
  }>();
  const firstTask = queue.queueTask({
    type: 'first',
    exec: async () => {
      executions.push('first');
      await firstTaskBlocker;
    },
  });
  const secondTask = queue.queueTask({
    type: 'second',
    exec: async () => {
      executions.push('second');
      markSecondTaskStarted();
      await secondTaskBlocker;
    },
  });
  const thirdTask = queue.queueTask({
    type: 'third',
    exec: async () => {
      executions.push('third');
    },
  });

  releaseFirstTask();
  await firstTask;
  await secondTaskStarted;
  const thirdRejection = expect(thirdTask).rejects.toThrow('Task queue aborted');
  const abortPromise = queue.abort();
  await thirdRejection;
  expect(executions).toEqual(['first', 'second']);

  releaseSecondTask();
  await secondTask;
  await abortPromise;
  expect(executions).toEqual(['first', 'second']);
});

it('keeps newly queued tasks behind an aborted running task until it ends', async () => {
  /// @case
  /// 1. A running task receives an abort signal but has not finished its executor yet.
  /// 2. A new task is queued before that running executor exits.
  /// @expect
  /// The new task remains serialized behind the running task and starts only after the original executor settles.
  let releaseRunningTask!: () => void;
  const runningTaskBlocker = new Promise<void>((resolve) => {
    releaseRunningTask = resolve;
  });
  const executions: string[] = [];
  const queue = new TaskQueue<{
    running: () => void;
    afterAbort: () => void;
  }>();
  const runningTask = queue.queueTask({
    type: 'running',
    exec: async () => {
      executions.push('running start');
      await runningTaskBlocker;
      executions.push('running end');
    },
  });

  const abortPromise = queue.abort();
  const afterAbortTask = queue.queueTask({
    type: 'afterAbort',
    exec: async () => {
      executions.push('after abort');
    },
  });
  await Promise.resolve();
  expect(executions).toEqual(['running start']);

  releaseRunningTask();
  await runningTask;
  await abortPromise;
  await afterAbortTask;
  expect(executions).toEqual(['running start', 'running end', 'after abort']);
});

it('does not merge new work into an aborted running task', async () => {
  /// @case
  /// 1. A running task accepts same-type merges and then receives an abort signal.
  /// 2. Another task of the same type is queued before the aborted executor exits.
  /// @expect
  /// The new task waits behind the aborted executor and then runs independently instead of merging into it.
  let releaseRunningTask!: () => void;
  const runningTaskBlocker = new Promise<void>((resolve) => {
    releaseRunningTask = resolve;
  });
  const executions: string[] = [];
  const queue = new TaskQueue<{
    build: () => string;
  }>();
  const runningTask = queue.queueTask({
    type: 'build',
    exec: async (ctx) => {
      executions.push('first start');
      ctx.acceptMerge = true;
      await runningTaskBlocker;
      executions.push('first end');
      return 'first';
    },
  });

  const abortPromise = queue.abort();
  const taskAfterAbort = queue.queueTask({
    type: 'build',
    exec: async () => {
      executions.push('second');
      return 'second';
    },
  });
  await Promise.resolve();
  expect(executions).toEqual(['first start']);

  releaseRunningTask();
  await expect(runningTask).resolves.toBe('first');
  await abortPromise;
  await expect(taskAfterAbort).resolves.toBe('second');
  expect(executions).toEqual(['first start', 'first end', 'second']);
});
