/**
 * Chat discovery. Scrolls the Teams sidebar and returns every conversation.
 *
 * Stateless: the agent does not remember chats. Messengly imports what it wants
 * into its own `Chat` model, keyed on the `threadId` returned here.
 */

const express = require('express');
const { scanChats } = require('../agent/scanChats');

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    const sessionKey = typeof req.query.session === 'string' && req.query.session.trim() ? req.query.session.trim() : 'default';
    const chats = await scanChats(sessionKey);
    res.json({ chats });
  } catch (err) { next(err); }
});

module.exports = router;
