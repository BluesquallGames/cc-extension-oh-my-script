import process from 'node:process';
import { format } from 'node:util';
import { dirname, join } from 'node:path';
import winston from 'winston';
import Transport from 'winston-transport';
import { ensureDirSync, outputFileSync } from 'fs-extra';
import { selfExtensionName, selfPackageJson } from './self-info.js';

const printf = (withEntry: boolean) => winston.format.printf(({ level, message, timestamp }) => {
  let output = '';
  if (timestamp) {
    output += format('%s[%s] ', timestamp, timestamp instanceof Date ? timestamp.valueOf() : '');
  }
  if (withEntry) {
    output += `[@<where?>] `;
  }
  output += format('%s: %s', level, message);
  return output;
});

const logFile = join(Editor.Project.tmpDir, 'logs', `${selfExtensionName}-${selfPackageJson.version}.log`);
ensureDirSync(dirname(logFile));

const logLevel = process.env.OMS_VERBOSE === '1' ? 'debug' : 'info';

export function createLogFile() {
  outputFileSync(logFile, '');
}

class EditorTransport extends Transport {
  override log(info: { level: string; message: string }, next: () => void) {
    const consoleMethod = (console[info.level as ('info' | 'error' | 'warn' | 'debug')]
      ?? console.log)
      .bind(console);
    consoleMethod.call(console, `[${selfExtensionName}] ` + info.message);
    next();
  }
}

export const logger = winston.createLogger({
  level: logLevel,
  format: winston.format.combine(
    winston.format.errors({ stack: true }),
    winston.format.splat(),
  ),
  transports: [
    new EditorTransport({
      level: logLevel,
      format: winston.format.combine(
        printf(false),
      ),
    }),
    new winston.transports.File({
      level: logLevel,
      filename: logFile,
      // options: { flags: 'w' },
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        printf(true),
      ),
    }),
  ],
});
