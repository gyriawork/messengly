/**
 * Pino logger singleton.
 */

const pino = require('pino');

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport:
    process.env.LOG_PRETTY === 'true'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
});

module.exports = logger;
