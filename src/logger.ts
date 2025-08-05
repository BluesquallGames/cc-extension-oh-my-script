import { dirname, join } from 'node:path';
import winston from 'winston';
import Transport from 'winston-transport';
import { ensureDirSync } from 'fs-extra';
import { selfExtensionName, selfPackageJson } from './self-info.js';

const printf = (withEntry: boolean) => winston.format.printf(({ level, message, timestamp }) => {
  let output = '';
  if (timestamp) {
    output += `${timestamp} `;
  }
  if (withEntry) {
    output += `[@<where?>] `;
  }
  output += `${level}: ${message}`;
  return output;
});

const logFile = join(Editor.Project.tmpDir, 'logs', `${selfExtensionName}-${selfPackageJson.version}.log`);
ensureDirSync(dirname(logFile));

class EditorTransport extends Transport {
  override log(info: any, next: () => void) {
    const consoleMethod = console[info.level as ('info' | 'error' | 'warn' | 'debug')] ?? console.log;
    consoleMethod.call(console, `[${selfExtensionName}] ` + info.message);
    next();
  }
}

export const logger = winston.createLogger({
  level: 'debug',
  format: winston.format.combine(
    winston.format.splat(),
  ),
  transports: [
    new EditorTransport({
      level: 'info',
      format: winston.format.combine(
        printf(false),
      ),
    }),
    new winston.transports.File({
      level: 'debug',
      filename: logFile,
      // options: { flags: 'w' },
      format: winston.format.combine(
        winston.format.timestamp(),
        printf(true),
      ),
    }),
  ],
});
