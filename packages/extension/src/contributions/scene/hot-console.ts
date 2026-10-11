import Module from 'node:module';
import { sep } from 'node:path';
import { format } from 'node:util';
import { logger } from '../../logger.js';

const logTag = `::hot-console::`;
const logTagRegex = new RegExp(logTag);

type RemoteLogLevel = 'log' | 'info' | 'warn' | 'error';

const consoleVendorMethods = '_vendor' in console && typeof console._vendor === 'object'
  && console._vendor
  ? console._vendor as Partial<typeof console>
  : undefined;

const remoteLogger = (() => {
  if (!consoleVendorMethods) {
    return undefined;
  }
  try {
    const r = Module.createRequire(Editor.App.path + sep);
    const remoteLogger = r('@base/electron-logger');
    return remoteLogger as {
      record: (level: RemoteLogLevel, log: string) => void;
      clear: (regex?: RegExp) => void;
    };
  } catch (err) {
    logger.error('Failed to get editor remote logger: %o', err);
    return undefined;
  }
})();

export class HotConsole {
  debug(...args: unknown[]) {
    this._log('debug', ...args);
  }

  log(...args: unknown[]) {
    return this.info(...args);
  }

  info(...args: unknown[]) {
    this._log('info', ...args);
  }

  warn(...args: unknown[]) {
    this._log('warn', ...args);
  }

  error(...args: unknown[]) {
    this._log('error', ...args);
  }

  assert(condition: boolean, ...args: unknown[]) {
    if (!condition) {
      this.error(...args);
    }
  }

  clear() {
    remoteLogger?.clear(logTagRegex);
  }

  private _log(level: 'debug' | 'info' | 'warn' | 'error' | 'log', ...args: unknown[]) {
    const formatted = format(...args);
    if (remoteLogger) {
      const remoteLevel = logLevelToRemoteLevel[level];
      if (remoteLevel) {
        remoteLogger.record(remoteLevel, `{hidden(${logTag})}${formatted}`);
      }
    }
    if (consoleVendorMethods?.[level]) {
      consoleVendorMethods?.[level](formatted);
    } else {
      console[level](formatted);
    }
  }
}

type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'log';

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const logLevelSeverities: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  log: 1,
  warn: 2,
  error: 3,
};

const logLevelToRemoteLevel: Record<LogLevel, RemoteLogLevel | undefined> = {
  debug: undefined,
  info: 'info',
  log: 'log',
  warn: 'warn',
  error: 'error',
};
