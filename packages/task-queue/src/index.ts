/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from 'node:assert';
import { promiseWithResolvers, type PromiseWithResolvers } from './promise-with-resolvers.js';
import EventEmitter from 'node:events';

export class TaskExecuteContext extends EventEmitter<{
  merge: [args: any];
  abort: [];
}> {
  acceptMerge = false;
}

type PromiseResolveValue<T> = T extends Promise<infer U> ? U : T;

export class TaskQueue<TTaskMap extends {
  [K in keyof TTaskMap]: (ctx: TaskExecuteContext) => unknown;
}> {
  queueTask<TType extends Extract<keyof TTaskMap, string>>(task: {
    type: TType;
    exec: (ctx: TaskExecuteContext) => Promise<PromiseResolveValue<ReturnType<TTaskMap[TType]>>>;
    mergeArgs?: any[];
  }): Promise<PromiseResolveValue<ReturnType<TTaskMap[TType]>>> {
    if (this._runningTask?.type === task.type) {
      if (this._runningTask.ctx.acceptMerge) {
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
        return pendingTask.execPromiseWithResolvers.promise;
      }
    }
    const execPromiseWithResolvers
      = promiseWithResolvers<PromiseResolveValue<ReturnType<TTaskMap[TType]>>>();
    const taskId = this._nextTaskId++;
    this._pendingTasks.push({
      id: taskId,
      type: task.type,
      exec: task.exec,
      execPromiseWithResolvers: execPromiseWithResolvers,
    });
    if (!this._runningPromise) {
      this._executeTasks();
    }
    return execPromiseWithResolvers.promise;
  }

  abort() {
    this._pendingTasks.length = 0;
    if (this._runningTask) {
      this._runningTask.ctx.emit('abort');
    }
    this._runningTask = undefined;
    const runningPromise = this._runningPromise;
    this._runningPromise = undefined;
    return runningPromise ?? Promise.resolve();
  }

  private _nextTaskId = 1;
  private _pendingTasks: Array<{
    id: number;
    type: string;
    exec: (ctx: TaskExecuteContext) => unknown;
    execPromiseWithResolvers: PromiseWithResolvers<any>;
  }> = [];

  private _runningTask: undefined | {
    id: number;
    type: string;
    ctx: TaskExecuteContext;
    execPromiseWithResolvers: PromiseWithResolvers<any>;
  };

  private _runningPromise: Promise<void> | undefined;

  private _executeTasks() {
    assert.ok(!this._runningPromise);
    const tasks = this._pendingTasks.slice();
    this._pendingTasks.length = 0;
    this._runningPromise = (async () => {
      for (const task of tasks) {
        const ctx = new TaskExecuteContext();
        this._runningTask = {
          id: task.id,
          type: task.type,
          ctx,
          execPromiseWithResolvers: task.execPromiseWithResolvers,
        };
        try {
          const result = await task.exec(ctx);
          task.execPromiseWithResolvers.resolve(result);
        } catch (err) {
          task.execPromiseWithResolvers.reject(err);
        } finally {
          this._runningTask = undefined;
        }
      }
    })()
      .finally(() => {
        this._runningPromise = undefined;
        if (this._pendingTasks.length !== 0) {
          this._executeTasks();
        } else {
          // logger.debug('Task queue empty, idling.');
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
