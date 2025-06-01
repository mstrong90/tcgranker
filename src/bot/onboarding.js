// src/bot/onboarding.js

const db = require('../db/db');
const config = require('../config');
const log = require('../utils/logger');
const getTokenInfo = require('../solana/tokeninfo');

/**
 * onboardingFlow:
 *  - If msg.text already looks like a Solana CA, skip straight to tokenInfo.
 *  - Otherwise, send the welcome prompt and wait once for a CA.
 */
async function onboardingFlow(bot, msg) {
  const chatId = msg.chat.id;
  const telegramId = msg.from.id;
  const username = msg.from.username
    ? msg.from.username
    : msg.from.first_name || 'there';

  // Trim incoming text
  const text = msg.text.trim();

  // Solana‐style CA regex: Base58, 32–44 characters
  const solanaCaRegex = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  const preSuppliedCA = solanaCaRegex.test(text);

  // ────────────── If the user already pasted a CA ──────────────
  if (preSuppliedCA) {
    const ca = text;
    log('CA received (pre-supplied):', ca);

    // 1) If this CA is already onboarded by this same user, show main menu
    const existingProject = db.getProject(telegramId, ca);
    if (existingProject && existingProject.owner_id === telegramId) {
      await bot.sendMessage(
        chatId,
        `Welcome back! Your project is already onboarded.\nWhat would you like to do today?`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '📊 Volume Bot', callback_data: `menu_volume_${ca}` }],
              [{ text: '🚀 Rank Bot', callback_data: `menu_rank_${ca}` }],
              [{ text: '👛 Wallets', callback_data: `project_wallets_${ca}` }],
              [{ text: '📄 My Projects', callback_data: 'my_projects' }]
            ]
          }
        }
      );
      return;
    }

    // 2) If someone else already onboarded this CA, block access
    if (existingProject && existingProject.owner_id !== telegramId) {
      await bot.sendMessage(
        chatId,
        "❌ This contract has already been onboarded by another user. If this is an error, please contact support."
      );
      return;
    }

    // 3) Otherwise, fetch token info & show confirmation buttons
    const tokenInfo = await getTokenInfo(ca);
    if (!tokenInfo) {
      await bot.sendMessage(
        chatId,
        "❌ Could not fetch token info. Please double-check your contract address."
      );
      return;
    }

    // Build the token info message
    let infoMsg =
      'Token detected:\n\n' +
      `*Name*: ${tokenInfo.name}\n` +
      `*Symbol*: ${tokenInfo.symbol}\n` +
      `*Decimals*: ${tokenInfo.decimals}\n` +
      `*Supply*: ${tokenInfo.supply}`;

    if (tokenInfo.logo) {
      await bot.sendPhoto(chatId, tokenInfo.logo, {
        caption: infoMsg,
        parse_mode: 'Markdown'
      });
    } else {
      await bot.sendMessage(chatId, infoMsg, { parse_mode: 'Markdown' });
    }

    // Ask the user to confirm or re-enter CA
    await bot.sendMessage(
      chatId,
      "Is this the correct project?",
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "✅ Yes, continue", callback_data: `confirm_ca_${ca}` }],
            [{ text: "❌ No, enter a different CA", callback_data: `restart_onboarding` }]
          ]
        }
      }
    );

    // Wait for their button click
    bot.once('callback_query', async (query) => {
      if (query.data === `confirm_ca_${ca}`) {
        // Double-check that no one else onboarded in the meantime
        const stillProject = db.getProject(telegramId, ca);
        if (stillProject && stillProject.owner_id !== telegramId) {
          await bot.sendMessage(
            chatId,
            "❌ This contract has already been onboarded by another user. If this is an error, please contact support."
          );
          await bot.answerCallbackQuery(query.id);
          return;
        }

        // Prompt for payment
        await bot.sendMessage(
          chatId,
          `To onboard your project, please pay a one-time fee of ${config.ONBOARDING_FEE} SOL to this wallet:\n\n\`${config.DEV_WALLET}\`\n\n` +
          `Once you've paid, reply here with your transaction ID (TxID).`,
          { parse_mode: 'Markdown' }
        );

        // Wait for TxID message
        bot.once('message', async (payMsg) => {
          const txid = payMsg.text.trim();
          // TODO: verify payment on‐chain using txid (e.g. check signature belonged to DEV_WALLET)

          db.addOrUpdateProject(
            telegramId,
            username,
            ca,
            tokenInfo.name,
            {
              owner_id: telegramId,
              date_onboarded: new Date().toISOString(),
              status: 'onboarded',
              project_wallet: null,
              market_maker_wallets: []
            }
          );

          await bot.sendMessage(
            chatId,
            "✅ Onboarding payment received! Your project is now live.\n\nWhat would you like to do?",
            {
              reply_markup: {
                inline_keyboard: [
                  [{ text: '📊 Volume Bot', callback_data: `menu_volume_${ca}` }],
                  [{ text: '🚀 Rank Bot', callback_data: `menu_rank_${ca}`   }],
                  [{ text: '👛 Wallets',   callback_data: `project_wallets_${ca}` }],
                  [{ text: '📄 My Projects', callback_data: 'my_projects' }]
                ]
              }
            }
          );
        });
      }
      else if (query.data === 'restart_onboarding') {
        // User wants to re‐enter CA: restart the entire flow
        onboardingFlow(bot, msg);
      }

      await bot.answerCallbackQuery(query.id);
    });

    return;
  }

  // ────────────── If no CA was supplied yet, send the welcome prompt and wait once ──────────────
  const welcomeMsg =
    `👋 Welcome, ${username}!\n\n` +
    `I'm **TCG Ranker**.\n\n` +
    `I can help your Solana project stand out!\n\n` +
    `What service are you interested in?\n\n` +
    `• 📊 **Volume Bot:** Consistently boost your 24-hour volume with realistic trading activity.\n\n` +
    `• 🚀 **Rank Bot:** Push your project up Dexscreener's trending pages for max visibility.\n\n` +
    `*Please enter the contract address (CA) to get started:*`;

  await bot.sendMessage(chatId, welcomeMsg, { parse_mode: 'Markdown' });

  // Now wait one more time for the user to paste a CA
  bot.once('message', async (caMsg) => {
    if (caMsg.text.startsWith('/start')) return; // ignore stray /start
    const ca = caMsg.text.trim();
    log('CA received:', ca);

    // Check if this user already has that project
    let project = db.getProject(telegramId, ca);
    if (project && project.owner_id === telegramId) {
      await bot.sendMessage(
        chatId,
        `Welcome back! Your project is already onboarded.\nWhat would you like to do today?`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '📊 Volume Bot', callback_data: `menu_volume_${ca}` }],
              [{ text: '🚀 Rank Bot',   callback_data: `menu_rank_${ca}`   }],
              [{ text: '👛 Wallets',    callback_data: `project_wallets_${ca}` }],
              [{ text: '📄 My Projects', callback_data: 'my_projects' }]
            ]
          }
        }
      );
      return;
    }

    // If this CA is already onboarded by someone else, block
    if (project && project.owner_id !== telegramId) {
      await bot.sendMessage(
        chatId,
        "❌ This contract has already been onboarded by another user. If this is an error, please contact support."
      );
      return;
    }

    // Fetch token info
    const tokenInfo = await getTokenInfo(ca);
    if (!tokenInfo) {
      await bot.sendMessage(
        chatId,
        "❌ Could not fetch token info. Please double-check your contract address."
      );
      return;
    }

    // Display token info
    let infoMsg =
      'Token detected:\n\n' +
      `*Name*: ${tokenInfo.name}\n` +
      `*Symbol*: ${tokenInfo.symbol}\n` +
      `*Decimals*: ${tokenInfo.decimals}\n` +
      `*Supply*: ${tokenInfo.supply}`;

    if (tokenInfo.logo) {
      await bot.sendPhoto(chatId, tokenInfo.logo, {
        caption: infoMsg,
        parse_mode: 'Markdown'
      });
    } else {
      await bot.sendMessage(chatId, infoMsg, { parse_mode: 'Markdown' });
    }

    // Ask for confirmation
    await bot.sendMessage(
      chatId,
      "Is this the correct project?",
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "✅ Yes, continue",        callback_data: `confirm_ca_${ca}` }],
            [{ text: "❌ No, enter a different CA", callback_data: `restart_onboarding` }]
          ]
        }
      }
    );

    // Wait for their button click again
    bot.once('callback_query', async (query) => {
      if (query.data === `confirm_ca_${ca}`) {
        // Double-check in case someone onboarded it while we waited
        const stillProject = db.getProject(telegramId, ca);
        if (stillProject && stillProject.owner_id !== telegramId) {
          await bot.sendMessage(
            chatId,
            "❌ This contract has already been onboarded by another user. If this is an error, please contact support."
          );
          await bot.answerCallbackQuery(query.id);
          return;
        }

        // Prompt for payment
        await bot.sendMessage(
          chatId,
          `To onboard your project, please pay a one-time fee of ${config.ONBOARDING_FEE} SOL to this wallet:\n\n\`${config.DEV_WALLET}\`\n\n` +
          `Once you've paid, reply here with your transaction ID (TxID).`,
          { parse_mode: 'Markdown' }
        );

        // Wait for TxID
        bot.once('message', async (payMsg) => {
          const txid = payMsg.text.trim();
          // TODO: verify payment on‐chain using txid

          db.addOrUpdateProject(
            telegramId,
            username,
            ca,
            tokenInfo.name,
            {
              owner_id: telegramId,
              date_onboarded: new Date().toISOString(),
              status: 'onboarded',
              project_wallet: null,
              market_maker_wallets: []
            }
          );

          await bot.sendMessage(
            chatId,
            "✅ Onboarding payment received! Your project is now live.\n\nWhat would you like to do?",
            {
              reply_markup: {
                inline_keyboard: [
                  [{ text: '📊 Volume Bot', callback_data: `menu_volume_${ca}` }],
                  [{ text: '🚀 Rank Bot',   callback_data: `menu_rank_${ca}`   }],
                  [{ text: '👛 Wallets',    callback_data: `project_wallets_${ca}` }],
                  [{ text: '📄 My Projects', callback_data: 'my_projects' }]
                ]
              }
            }
          );
        });
      }
      else if (query.data === 'restart_onboarding') {
        // User wants to re‐enter CA
        onboardingFlow(bot, msg);
      }

      await bot.answerCallbackQuery(query.id);
    });
  });
}

module.exports = onboardingFlow;
