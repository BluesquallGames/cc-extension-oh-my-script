import assert from 'node:assert';
import { logger } from './logger.js';
import { promiseWithResolvers, type PromiseWithResolvers } from './utils/promise-with-resolvers.js';
import EventEmitter from 'node:events';

export class TaskExecuteContext extends EventEmitter<{
  merge: [args: any];
  abort: [];
}> {
  constructor(public readonly initialMergeArgs: any[][] = []) {
    super();
  }

  acceptMerge = false;
}

export class TaskQueue<TTaskMap extends {
  [x: string]: (ctx: TaskExecuteContext) => any;
}> {
  queueTask<TType extends Extract<keyof TTaskMap, string>>(task: {
    type: TType;
    exec: (ctx: TaskExecuteContext) => Promise<ReturnType<TTaskMap[TType]>>;
    mergeArgs?: any[];
  }): Promise<ReturnType<TTaskMap[TType]>> {
    if (this._runningTask && !this._runningTask.aborting && this._runningTask.type === task.type) {
      if (this._runningTask.ctx.acceptMerge) {
        logger.debug(`Queuing task [${task.type}] merged with running task ${this._runningTask.id}[${this._runningTask.type}].`);
        this._runningTask.ctx.emit('merge', task.mergeArgs);
        return this._runningTask.execPromiseWithResolvers.promise.then(
          (value) => {
            return value;
          },
          (reason) => {
            throw new MergedTaskExecError(reason);
          },
        );
      }
    }
    for (const pendingTask of this._pendingTasks) {
      if (pendingTask.type === task.type) {
        logger.debug(`Queuing task [${task.type}] merged with pending task ${pendingTask.id}[${pendingTask.type}].`);
        if (task.mergeArgs !== undefined) {
          pendingTask.initialMergeArgs.push(task.mergeArgs);
        }
        return pendingTask.execPromiseWithResolvers.promise;
      }
    }
    logger.debug(`Queue task: [${task.type}]`);
    const execPromiseWithResolvers = promiseWithResolvers<ReturnType<TTaskMap[TType]>>();
    const taskId = this._nextTaskId++;
    this._pendingTasks.push({
      id: taskId,
      type: task.type,
      exec: task.exec,
      initialMergeArgs: [],
      execPromiseWithResolvers: execPromiseWithResolvers,
    });
    logger.debug(`Task ${taskId}[${task.type}] queued, now pending.`);
    if (!this._runningPromise) {
      logger.debug(`Start execute task queue`);
      this._executeTasks();
    }
    return execPromiseWithResolvers.promise;
  }

  abort() {
    const pendingTasks = this._pendingTasks.splice(0);
    for (const pendingTask of pendingTasks) {
      pendingTask.execPromiseWithResolvers.reject(new Error('Task queue aborted'));
    }
    if (this._runningTask && !this._runningTask.aborting) {
      this._runningTask.aborting = true;
      this._runningTask.ctx.emit('abort');
    }
    return this._runningPromise ?? Promise.resolve();
  }

  private _nextTaskId = 1;
  private _pendingTasks: Array<{
    id: number;
    type: string;
    exec: (ctx: TaskExecuteContext) => unknown;
    initialMergeArgs: any[][];
    execPromiseWithResolvers: PromiseWithResolvers<any>;
  }> = [];

  private _runningTask: undefined | {
    id: number;
    type: string;
    ctx: TaskExecuteContext;
    aborting: boolean;
    execPromiseWithResolvers: PromiseWithResolvers<any>;
  };

  private _runningPromise: Promise<void> | undefined;

  private _executeTasks() {
    assert.ok(!this._runningPromise);
    const task = this._pendingTasks.shift();
    assert.ok(task);
    this._runningPromise = (async () => {
      const ctx = new TaskExecuteContext(task.initialMergeArgs);
      this._runningTask = {
        id: task.id,
        type: task.type,
        ctx,
        aborting: false,
        execPromiseWithResolvers: task.execPromiseWithResolvers,
      };
      try {
        logger.debug(`Execute task ${task.id}[${task.type}]`);
        const result = await task.exec(ctx);
        task.execPromiseWithResolvers.resolve(result);
        logger.debug(`Task ${task.id}[${task.type}] done`);
      } catch (err) {
        logger.debug(`Task ${task.id}[${task.type}] failed: %o`, err);
        task.execPromiseWithResolvers.reject(err);
      } finally {
        this._runningTask = undefined;
      }
    })()
      .catch((err) => {
        logger.error(err);
      })
      .finally(() => {
        this._runningPromise = undefined;
        if (this._pendingTasks.length !== 0) {
          this._executeTasks();
        } else {
          logger.debug('Task queue empty, idling.');
        }
      });
  }
}

export class MergedTaskExecError extends Error {
  constructor(cause: Error) {
    super('Merged task execution failed', { cause });
    this._cause = cause;
  }

  override get cause() {
    return this._cause;
  }

  private _cause: Error;
}
