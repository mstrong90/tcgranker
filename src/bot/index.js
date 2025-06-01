require('dotenv').config();
require('.');
const TelegramBot = require('node-telegram-bot-api');
const handleWalletsMenu = require('./menu');
const wallets = require('./solana/wallets');




const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const NODE_ENV = process.env.NODE_ENV || 'dev'; // Default to dev for safety

// Set polling for dev, consider webhook for prod if you want to scale
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// Util function for logging (only logs in dev)
function log(...args) {
  if (NODE_ENV === 'dev') console.log('[DEV]', ...args);
}

// Inline keyboard for main menu
const mainMenu = {
  reply_markup: {
    inline_keyboard: [
      [
        { text: '📊 Volume Bot', callback_data: 'volume_bot' },
        { text: '🚀 Rank Bot', callback_data: 'rank_bot' }
      ]
    ]
  }
};

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const username = msg.from.username
    ? msg.from.username
    : msg.from.first_name || 'there';

  const welcomeMsg = `👋 Welcome, ${username}!\n\nI'm **TCG Ranker**.\n\nI can help your Solana project stand out!\n\n What service are you interested in?\n\n• 📊 **Volume Bot:** Consistently boost your 24-hour volume with realistic trading activity.\n\n• 🚀 **Rank Bot:** Push your project up Dexscreener's trending pages for max visibility.\n\nChoose a service to get started:`;

  await bot.sendMessage(chatId, welcomeMsg, {
    parse_mode: 'Markdown',
    ...mainMenu
  });
  log('Sent welcome message to', username, `(chat ${chatId})`);
});

// Handle button presses
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const userId = query.from.id;
  log(`Button pressed: ${query.data} by ${userId}`);

  if (query.data === 'volume_bot') {
    await bot.sendMessage(chatId, "📊 *Volume Bot* will keep steady, organic transactions flowing through your chart, building your 24h volume. [Set up coming soon!]", { parse_mode: 'Markdown' });
  }
  if (query.data === 'rank_bot') {
    await bot.sendMessage(chatId, "🚀 *Rank Bot* will boost your project up Dexscreener's trending pages with smart, high-frequency micro-transactions. [Set up coming soon!]", { parse_mode: 'Markdown' });
  }
  // Acknowledge the callback to remove "loading" animation
  bot.answerCallbackQuery(query.id);
});

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;

  // Wallets Menu
  if (query.data.startsWith('project_wallets_')) {
  const ca = query.data.replace('project_wallets_', '');
  await handleWalletsMenu(bot, query.message.chat.id, ca, query.from.id);
}

  // Generate Project Wallet
  if (data.startsWith('gen_project_wallet_')) {
    const ca = data.replace('gen_project_wallet_', '');
    let project = db.getProject(ca);
    if (project && !project.project_wallet) {
      const wallet = wallets.createWallet();
      project.project_wallet = wallet;
      db.updateProject(ca, { project_wallet: wallet });
      await bot.sendMessage(chatId, '✅ Project wallet generated!');
      await handleWalletsMenu(bot, chatId, ca);
    }
  }

  // Generate Market Makers (initial batch of 5)
  if (data.startsWith('gen_market_makers_')) {
    const ca = data.replace('gen_market_makers_', '');
    let project = db.getProject(ca);
    if (project && (!project.market_maker_wallets || project.market_maker_wallets.length === 0)) {
      let walletsList = [];
      for (let i = 0; i < 5; i++) {
        walletsList.push(wallets.createWallet());
      }
      project.market_maker_wallets = walletsList;
      db.updateProject(ca, { market_maker_wallets: walletsList });
      await bot.sendMessage(chatId, '✅ 5 Market Maker wallets generated!');
      await handleWalletsMenu(bot, chatId, ca);
    }
  }
});

log('TCGRanker bot is running in', NODE_ENV, 'mode.');
