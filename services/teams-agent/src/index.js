/**
 * Teams agent — a private HTTP service that drives the Teams web UI with
 * Playwright on behalf of Messengly.
 *
 * Ported from meetsbroadcast's backend. It knows nothing about organizations,
 * broadcasts or databases: it logs in, lists chats, and sends one message at a
 * time. Everything else stays in Messengly.
 */

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');

const logger = require('./util/logger');
const config = require('./config');
const { requireApiKey } = require('./middleware/apiKey');
const lock = require('./agent/lock');
const browser = require('./agent/browser');

const sessionRoutes = require('./routes/session');
const chatRoutes = require('./routes/chats');
const messageRoutes = require('./routes/messages');

// Fail-closed: the key is required unless the env is EXPLICITLY development.
// An unset NODE_ENV (misconfigured deploy, staging) must not run open.
if (process.env.NODE_ENV !== 'development' && !config.API_KEY) {
  logger.error('TEAMS_AGENT_API_KEY is required outside development — refusing to start');
  process.exit(1);
}

const app = express();

app.use(helmet());
app.use(cors({ origin: false })); // service-to-service only; no browser origins
app.use(express.json({ limit: '1mb' }));

// Health is unauthenticated so Railway can probe it.
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    hasSession: browser.hasSession(),
    busy: lock.isLocked(),
    queueDepth: lock.queueDepth(),
    timestamp: new Date().toISOString(),
  });
});

app.use('/session', requireApiKey, sessionRoutes);
app.use('/chats', requireApiKey, chatRoutes);
app.use('/messages', requireApiKey, messageRoutes);

app.use((req, res) => {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: `No route for ${req.method} ${req.path}` } });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  logger.error({ err: err.message, stack: err.stack, path: req.path }, 'Unhandled error');
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
});

const server = app.listen(config.PORT, config.HOST, () => {
  logger.info(
    { port: config.PORT, host: config.HOST, hasSession: browser.hasSession(), authenticated: !!config.API_KEY },
    'Teams agent listening'
  );
});

async function shutdown(signal) {
  logger.info({ signal }, 'Shutting down');
  server.close();
  await browser.close().catch(() => {});
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = app;
