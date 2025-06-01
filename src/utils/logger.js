// src/utils/logger.js
const NODE_ENV = process.env.NODE_ENV || 'dev';

function log(...args) {
  if (NODE_ENV === 'dev') {
    console.log('[DEV]', ...args);
  }
}

module.exports = log;
