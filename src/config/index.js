// src/config/index.js
require('dotenv').config();

module.exports = {
  DEV_WALLET: process.env.DEV_WALLET, // your fee wallet
  ONBOARDING_FEE: 1.5, // in SOL, change as needed
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  HELIUS_API_KEY: process.env.HELIUS_API_KEY,
  SOLANA_RPC_URL: process.env.SOLANA_RPC_URL
  // add other config as needed
};
