// src/bot/onboarding.js
const db = require('../db/db');
const config = require('../config');
const log = require('../utils/logger');
const getTokenInfo = require('../solana/tokeninfo');

async function onboardingFlow(bot, msg) {
  const chatId = msg.chat.id;
  const telegramId = msg.from.id;
  const username = msg.from.username
    ? msg.from.username
    : msg.from.first_name || 'there';

  // Welcome message
  const welcomeMsg = `👋 Welcome, ${username}!\n\nI'm **TCG Ranker**.\n\nI can help your Solana project stand out!\n\nWhat service are you interested in?\n\n• 📊 **Volume Bot:** Consistently boost your 24-hour volume with realistic trading activity.\n\n• 🚀 **Rank Bot:** Push your project up Dexscreener's trending pages for max visibility.\n\n*Please enter the contract address (CA) to get started:*`;

  await bot.sendMessage(chatId, welcomeMsg, { parse_mode: 'Markdown' });

  bot.once('message', async (caMsg) => {
    if (caMsg.text.startsWith('/start')) return;
    const ca = caMsg.text.trim();
    log('CA received:', ca);

    let project = db.getProject(telegramId, ca);

    // RETURNING USER: SKIP TOKEN INFO/CONFIRMATION!
    if (project && project.owner_id === telegramId) {
      await bot.sendMessage(chatId, `Welcome back! Your project is already onboarded.\nWhat would you like to do today?`, {
        reply_markup: {
          inline_keyboard: [
            [{ text: '📊 Volume Bot', callback_data: `menu_volume_${ca}` }],
            [{ text: '🚀 Rank Bot', callback_data: `menu_rank_${ca}` }],
            [{ text: '👛 Wallets', callback_data: `project_wallets_${ca}` }],
            [{ text: '📄 My Projects', callback_data: 'my_projects' }]
          ]
        }
      });
      return;
    }

    // If CA is already onboarded by another user, block access
    if (project && project.owner_id !== telegramId) {
      await bot.sendMessage(chatId, "❌ This contract has already been onboarded by another user. If this is an error, contact support.");
      return;
    }

    // New project onboarding: fetch token info and confirm
    const tokenInfo = await getTokenInfo(ca);

    if (!tokenInfo) {
      await bot.sendMessage(chatId, "❌ Could not fetch token info. Please double-check your contract address.");
      return;
    }

    // Display token info for confirmation
    let infoMsg = `Token detected:\n\n*Name*: ${tokenInfo.name}\n*Symbol*: ${tokenInfo.symbol}\n*Decimals*: ${tokenInfo.decimals}\n*Supply*: ${tokenInfo.supply}`;
    if (tokenInfo.logo) {
      await bot.sendPhoto(chatId, tokenInfo.logo, { caption: infoMsg, parse_mode: 'Markdown' });
    } else {
      await bot.sendMessage(chatId, infoMsg, { parse_mode: 'Markdown' });
    }

    // Confirm with user before proceeding
    await bot.sendMessage(chatId, "Is this the correct project?", {
      reply_markup: {
        inline_keyboard: [
          [{ text: "✅ Yes, continue", callback_data: `confirm_ca_${ca}` }],
          [{ text: "❌ No, enter a different CA", callback_data: `restart_onboarding` }]
        ]
      }
    });

    // Wait for confirmation
    bot.once('callback_query', async (query) => {
      if (query.data === `confirm_ca_${ca}`) {
        // Repeat check in case project was onboarded during delay
        let project = db.getProject(ca);
        if (project && project.owner_id !== telegramId) {
          await bot.sendMessage(chatId, "❌ This contract has already been onboarded by another user. If this is an error, contact support.");
          bot.answerCallbackQuery(query.id);
          return;
        }

        // Proceed with onboarding/payment
        await bot.sendMessage(
          chatId,
          `To onboard your project, please pay a one-time fee of ${config.ONBOARDING_FEE} SOL to this wallet:\n\n\`${config.DEV_WALLET}\`\n\nYou'll then get access to both Volume and Rank bots for this contract!\n\nAfter sending payment, reply here with your transaction ID (TxID).`,
          { parse_mode: 'Markdown' }
        );

        bot.once('message', async (payMsg) => {
          const txid = payMsg.text.trim();
          // TODO: Payment verification logic here!
          db.addOrUpdateProject(
  telegramId,
  username,
  ca,
  tokenInfo.name, // Or whatever token_name you want to display
  {
    owner_id: telegramId,
    date_onboarded: new Date().toISOString(),
    status: 'onboarded',
    project_wallet: null,
    market_maker_wallets: []
  }
);
          await bot.sendMessage(chatId, "✅ Onboarding payment received! Your project is now live.\n\nWhat would you like to do?", {
            reply_markup: {
              inline_keyboard: [
                [{ text: '📊 Volume Bot', callback_data: `menu_volume_${ca}` }],
                [{ text: '🚀 Rank Bot', callback_data: `menu_rank_${ca}` }],
                [{ text: '👛 Wallets', callback_data: `project_wallets_${ca}` }],
                [{ text: '📄 My Projects', callback_data: 'my_projects' }]
              ]
            }
          });
        });
      } else if (query.data === 'restart_onboarding') {
        onboardingFlow(bot, msg); // Restart onboarding
      }
      bot.answerCallbackQuery(query.id);
    });
  });
}

module.exports = onboardingFlow;
