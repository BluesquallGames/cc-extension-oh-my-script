import winston from 'winston';

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
    new winston.transports.Console({
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
