import { createWriteStream } from 'node:fs';
import winston from 'winston';

const { logFd } = (() => {
  const logFd = (() => {
    const logFdEnv = process.env.OMS_BUILDER_CORE_LOG_FD;
    if (!logFdEnv) {
      return undefined;
    }
    const o = Number.parseInt(logFdEnv);
    if (isNaN(o) || !Number.isFinite(o) || o < 0) {
      return undefined;
    }
    return o;
  })();

  return { logFd };
})();

const logStream = (() => {
  if (!logFd) {
    return undefined;
  }
  try {
    return createWriteStream('', { fd: logFd });
  } catch (err) {
    console.error(`createWriteStream failed: ${err}`);
    return undefined;
  }
})();

const printf = () => winston.format.printf(({ level, message, timestamp }) => {
  let output = '';
  if (timestamp) {
    output += `${timestamp} `;
  }
  output += `${level}: ${message}`;
  return output;
});

export let logger = winston.createLogger({
  format: winston.format.combine(
    winston.format.errors({ stack: true }),
    winston.format.splat(),
  ),
  transports: [
    logStream
      ? new winston.transports.Stream({
        level: 'debug',
        format: winston.format.combine(
          winston.format.errors({ stack: true }),
          winston.format.json(),
        ),
        stream: logStream,
      })
      : new winston.transports.Console({
        level: 'debug',
        format: winston.format.combine(
          winston.format.errors({ stack: true }),
          printf(),
        ),
        stderrLevels: ['error', 'warn'],
      }),
  ],
});

export function setLogger(newLogger: winston.Logger) {
  logger = newLogger;
}
