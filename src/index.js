require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const config = require('./config');
const handleOnboarding = require('./bot/onboarding');
const handleWalletsMenu = require('./bot/menu');
const db = require('./db/db');
const wallets = require('./solana/wallets');
const { Connection, PublicKey } = require('@solana/web3.js');
const { buildVolumeConfig } = require('./config/volume');
const tradingEngine = require('./trading/engine');
const { userVolumeConfig, awaitingSetting, getVolumeCustomizeMenu } = require('./bot/volume_customize');

const heliusKeys = process.env.HELIUS_API_KEYS.split(',').map(k => k.trim());
let heliusIndex = 0;

function getNextHeliusKey() {
  const key = heliusKeys[heliusIndex];
  heliusIndex = (heliusIndex + 1) % heliusKeys.length;
  return key;
}

function getHeliusConnection() {
  return new Connection(`https://mainnet.helius-rpc.com/?api-key=${getNextHeliusKey()}`);
}

const bot = new TelegramBot(config.TELEGRAM_BOT_TOKEN, { polling: true });
// When you need a Connection (e.g., in a trade loop or wallet helper)
const connection = new Connection(`https://mainnet.helius-rpc.com/?api-key=${getNextHeliusKey()}`);

// ----------- AUTO PAYMENT POLLING FOR BUY MAKERS ----------- //
const pendingPayments = {}; // { [userId]: { ca, qty, cost, startedAt, startingSlot } }

async function startPaymentPolling(userId, ca, qty, cost, chatId, devWallet, bot, db, wallets, handleWalletsMenu) {
  const startingSlot = await connection.getSlot('confirmed');
  pendingPayments[userId] = { ca, qty, cost, startedAt: Date.now(), startingSlot };

  const interval = setInterval(async () => {
    // Stop after 10 minutes if not paid
    if (Date.now() - pendingPayments[userId].startedAt > 10 * 60 * 1000) {
      clearInterval(interval);
      delete pendingPayments[userId];
      bot.sendMessage(chatId, "❌ Payment window expired. Please try again.");
      return;
    }

    let sigs = [];
    try {
      sigs = await connection.getSignaturesForAddress(new PublicKey(devWallet), { limit: 20 }, "confirmed");
    } catch (e) {
      if (e.message && e.message.includes('Failed to query long-term storage')) {
        return;
      } else {
        console.error('[Payment Polling] getSignaturesForAddress error:', e.message);
        return;
      }
    }

    for (const sig of sigs) {
      if (sig.slot <= pendingPayments[userId].startingSlot) continue; // Only new txs

      const tx = await connection.getTransaction(sig.signature, { commitment: "confirmed" });
      if (!tx) continue;

      // Find the dev wallet index in this transaction's accountKeys
      const devWalletIndex = tx.transaction.message.accountKeys.findIndex(
        (k) => k.toBase58() === devWallet
      );
      if (devWalletIndex === -1) continue;

      // Compare balances before/after this transaction for dev wallet
      const pre = tx.meta.preBalances[devWalletIndex];
      const post = tx.meta.postBalances[devWalletIndex];
      const diff = (post - pre) / 1e9;

      // Use a "fuzzy" match to handle possible rounding/fee effects
      if (Math.abs(diff - parseFloat(cost)) < 0.0001) {
        // Payment detected!
        clearInterval(interval);
        delete pendingPayments[userId];

        // Add the wallets
        let project = db.getProject(userId, ca);
        if (!project) {
          bot.sendMessage(chatId, "Project not found.");
          return;
        }
        if (!project.market_maker_wallets) project.market_maker_wallets = [];
        for (let i = 0; i < Number(qty); i++) {
          project.market_maker_wallets.push(wallets.createWallet());
        }
        db.addOrUpdateProject(userId, null, ca, project.token_name || "", project);
        bot.sendMessage(
          chatId,
          `✅ Payment received!\n\n*${qty}* new Market Maker wallets have been added to your project.\n` +
          `*Important:* These wallets need to be funded with SOL to be used for trading.`
        );
        handleWalletsMenu(bot, chatId, ca, userId);
        return;
      }
    }
  }, 5000); // poll every 5 seconds
}


// ----------- START/ONBOARD ----------- //
bot.onText(/\/start/, (msg) => {
  handleOnboarding(bot, msg);
});

// ----------- CALLBACK HANDLER ----------- //
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const userId = query.from.id;
  const data = query.data;

  // WALLET MENU (handles refresh, back, etc)
  if (data.startsWith('project_wallets_')) {
    const ca = data.replace('project_wallets_', '');
    await handleWalletsMenu(bot, chatId, ca, userId);
    bot.answerCallbackQuery(query.id);
    return;
  }

  // Generate Project Wallet
  if (data.startsWith('gen_project_wallet_')) {
    const ca = data.replace('gen_project_wallet_', '');
    let project = db.getProject(userId, ca);
    if (project && !project.project_wallet) {
      const wallet = wallets.createWallet();
      project.project_wallet = wallet;
      db.addOrUpdateProject(
        userId,
        query.from.username,
        ca,
        project.token_name || "",
        project
      );
      await bot.sendMessage(chatId, '✅ Project wallet generated!');
      await handleWalletsMenu(bot, chatId, ca, userId);
    }
    bot.answerCallbackQuery(query.id);
    return;
  }

  // Generate Market Makers (first 5 free)
  if (data.startsWith('gen_market_makers_')) {
    const ca = data.replace('gen_market_makers_', '');
    let project = db.getProject(userId, ca);
    if (project && (!project.market_maker_wallets || project.market_maker_wallets.length === 0)) {
      let walletsList = [];
      for (let i = 0; i < 5; i++) {
        walletsList.push(wallets.createWallet());
      }
      project.market_maker_wallets = walletsList;
      db.addOrUpdateProject(
        userId,
        query.from.username,
        ca,
        project.token_name || "",
        project
      );
      await bot.sendMessage(chatId, '✅ 5 Market Maker wallets generated!');
      await handleWalletsMenu(bot, chatId, ca, userId);
    }
    bot.answerCallbackQuery(query.id);
    return;
  }

  // SELL ALL (swap + sweep)
  if (data.startsWith('sell_all_')) {
    const ca = data.replace('sell_all_', '');
    let project = db.getProject(userId, ca);
    if (!project || !project.project_wallet || !project.market_maker_wallets || project.market_maker_wallets.length === 0) {
      await bot.sendMessage(chatId, 'No funds to sell.');
      bot.answerCallbackQuery(query.id);
      return;
    }
    await bot.sendMessage(chatId, '💸 Initiating "Sell All"... (this may take a minute)');
    await wallets.sellAllMarketMakers(bot, chatId, project, ca);
    await handleWalletsMenu(bot, chatId, ca, userId);
    bot.answerCallbackQuery(query.id);
    return;
  }

  // WITHDRAW (prompt for address)
  if (data.startsWith('withdraw_')) {
    const ca = data.replace('withdraw_', '');
    let project = db.getProject(userId, ca);
    if (!project || !project.project_wallet) {
      await bot.sendMessage(chatId, 'No project wallet found.');
      bot.answerCallbackQuery(query.id);
      return;
    }
    await bot.sendMessage(chatId, '🏦 Please enter the Solana wallet address to withdraw all funds to:');
    bot.once('message', async (msg) => {
      const withdrawAddress = msg.text.trim();
      await bot.sendMessage(chatId, `Withdrawing all funds to \`${withdrawAddress}\`...`, { parse_mode: 'Markdown' });

      try {
        const sig = await wallets.withdrawAllSol(project.project_wallet.secret, withdrawAddress);
        await bot.sendMessage(
          chatId,
          `✅ *Withdrawal complete!*\n\nTx: [View on Solscan](https://solscan.io/tx/${sig})\n\n` +
          `_A small amount (usually 0.00089088 SOL) remains in your project wallet as a rent reserve. This is required by the Solana network and cannot be withdrawn._`,
          { parse_mode: 'Markdown' }
        );
        await handleWalletsMenu(bot, chatId, ca, userId);
      } catch (err) {
        await bot.sendMessage(chatId, `❌ Error withdrawing funds: ${err.message}`);
      }
    });
    bot.answerCallbackQuery(query.id);
    return;
  }

  // DISTRIBUTE
  if (data.startsWith('distribute_')) {
    const ca = data.replace('distribute_', '');
    let project = db.getProject(userId, ca);

    if (
      !project ||
      !project.project_wallet ||
      !project.market_maker_wallets ||
      project.market_maker_wallets.length === 0
    ) {
      await bot.sendMessage(chatId, 'No market maker wallets to distribute to.');
      bot.answerCallbackQuery(query.id);
      return;
    }

    await bot.sendMessage(chatId, '🔀 Distributing SOL from project wallet to market makers...');
    try {
      const sig = await wallets.distributeSol(
        project.project_wallet.secret,
        project.market_maker_wallets.map(w => w.pubkey)
      );
      await bot.sendMessage(chatId, `✅ Distribution complete! Tx: https://solscan.io/tx/${sig}`);
      await handleWalletsMenu(bot, chatId, ca, userId);
    } catch (err) {
      await bot.sendMessage(chatId, `❌ Error distributing funds: ${err.message}`);
    }
    bot.answerCallbackQuery(query.id);
    return;
  }

  // BUY MORE MAKERS BUTTON
  if (data.startsWith('buy_more_makers_')) {
    const ca = data.replace('buy_more_makers_', '');
    await bot.sendMessage(chatId,
      `🚀 Want more Market Makers?\n\n` +
      `Extra Market Makers stay with your project for life and can always be used in future bots!\n\n` +
      `Choose a package:`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '5 More - 0.08 SOL', callback_data: `buy_makers|${ca}|5|0.08` }],
            [{ text: '10 More - 0.15 SOL', callback_data: `buy_makers|${ca}|10|0.15` }],
            [{ text: '15 More - 0.23 SOL', callback_data: `buy_makers|${ca}|15|0.23` }],
            [{ text: '20 More - 0.29 SOL', callback_data: `buy_makers|${ca}|20|0.29` }],
            [{ text: '25 More - 0.35 SOL', callback_data: `buy_makers|${ca}|25|0.35` }],
            [{ text: '⬅️ Back', callback_data: `project_wallets_${ca}` }]
          ]
        }
      }
    );
    bot.answerCallbackQuery(query.id);
    return;
  }

  // BUY MAKERS AUTO PAYMENT FLOW (now only new txs, no long-term storage errors)
  if (data.startsWith('buy_makers|')) {
    const [_, ca, qty, cost] = data.split('|');
    const devWallet = process.env.DEV_WALLET;
    await bot.sendMessage(
      chatId,
      `To buy *${qty}* more Market Makers for *${cost} SOL*:\n\n` +
      `1. Send *exactly* \`${cost}\` SOL to this address:\n\`${devWallet}\`\n\n` +
      `_This payment will be detected automatically. Market Maker wallets are for life!_\n\n` +
      `⏳ *Waiting for your payment...*`,
      { parse_mode: 'Markdown' }
    );
    // Start polling only for new deposits from NOW
    startPaymentPolling(userId, ca, qty, cost, chatId, devWallet, bot, db, wallets, handleWalletsMenu);
    bot.answerCallbackQuery(query.id);
    return;
  }

  // REFRESH WALLET MENU
  if (data.startsWith('refresh_wallets_')) {
    const ca = data.replace('refresh_wallets_', '');
    await handleWalletsMenu(bot, chatId, ca, userId);
    bot.answerCallbackQuery(query.id, { text: "Balances refreshed!" });
    return;
  }

  // BACK TO MAIN MENU
  if (data.startsWith('back_main_')) {
    const ca = data.replace('back_main_', '');
    let project = db.getProject(userId, ca);
    await bot.sendMessage(chatId, `What would you like to do for ${project.token_name || 'your project'}?`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: '📊 Volume Bot', callback_data: `menu_volume_${ca}` }],
          [{ text: '🚀 Rank Bot', callback_data: `menu_rank_${ca}` }],
          [{ text: '👛 Wallets', callback_data: `project_wallets_${ca}` }],
          [{ text: '📄 My Projects', callback_data: 'my_projects' }]
        ]
      }
    });
    bot.answerCallbackQuery(query.id);
    return;
  }

// Volume Bot: Show info and SOL amount buttons
if (data.startsWith('menu_volume_')) {
  const ca = data.replace('menu_volume_', '');
  await bot.sendMessage(
    chatId,
    "📊 *Organic Volume Bot*\n\n" +
    "This bot will generate organic, randomized buy/sell volume on your token using your market maker wallets.\n\n" +
    "Select the amount of SOL to run your session:",
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: "⚙️ Customize Settings", callback_data: `customize_volume|${ca}` }],
          [{ text: '1 SOL', callback_data: `volume_run|${ca}|1` }],
          [{ text: '2 SOL', callback_data: `volume_run|${ca}|2` }],
          [{ text: '3 SOL', callback_data: `volume_run|${ca}|3` }],
          [{ text: '4 SOL', callback_data: `volume_run|${ca}|4` }],
          [{ text: '5 SOL', callback_data: `volume_run|${ca}|5` }],
          [{ text: '⬅️ Back', callback_data: `back_main_${ca}` }]
        ]
      }
    }
  );
  bot.answerCallbackQuery(query.id);
  return;
}

// Customize Volume Config
if (data.startsWith('customize_volume|')) {
  const ca = data.split('|')[1];
  // Save CA for future reference during customization
  awaitingSetting[chatId] = { ca }; // Optionally track CA

  await bot.sendMessage(
    chatId,
    "🛠 *Customize your volume bot settings:*\n\n" +
    "• *Buy Min / Max*: Smallest and largest SOL amount per buy.\n" +
    "• *Interval Min / Max*: Shortest and longest pause (in seconds) between trades.\n\n" +
    "Tap a setting below to update it:",
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            { text: "Set Buy Min", callback_data: "set_buy_min" },
            { text: "Set Buy Max", callback_data: "set_buy_max" }
          ],
          [
            { text: "Set Interval Min", callback_data: "set_interval_min" },
            { text: "Set Interval Max", callback_data: "set_interval_max" }
          ],
          [{ text: "⬅️ Back", callback_data: `menu_volume_${ca}` }]
        ]
      }
    }
  );
  bot.answerCallbackQuery(query.id);
  return;
}

// Handle Setting Change Buttons
if (["set_buy_min", "set_buy_max", "set_interval_min", "set_interval_max"].includes(data)) {
  let setting, label;
  switch (data) {
    case "set_buy_min": setting = "buy_min"; label = "Buy Min (in SOL)"; break;
    case "set_buy_max": setting = "buy_max"; label = "Buy Max (in SOL)"; break;
    case "set_interval_min": setting = "interval_min"; label = "Interval Min (in seconds)"; break;
    case "set_interval_max": setting = "interval_max"; label = "Interval Max (in seconds)"; break;
  }
  awaitingSetting[chatId] = { ...(awaitingSetting[chatId] || {}), setting };
  await bot.sendMessage(chatId, `Please enter your new value for *${label}*:`, { parse_mode: 'Markdown' });
  bot.answerCallbackQuery(query.id);
  return;
}


// Start volume session
if (data.startsWith('volume_run|')) {
  const [_, ca, solAmountStr] = data.split('|');
  const solAmount = Number(solAmountStr);

  const project = db.getProject(userId, ca);
  if (!project) {
    await bot.sendMessage(chatId, "❌ Project not found.");
    bot.answerCallbackQuery(query.id);
    return;
  }

  // Build config dynamically
  const { buildVolumeConfig } = require('./config/volume');
  const custom = userVolumeConfig[chatId] || {};
const sessionConfig = buildVolumeConfig({
  ca,
  solAmount,
  buy_min: custom.buy_min,
  buy_max: custom.buy_max,
  interval_min: custom.interval_min,
  interval_max: custom.interval_max
});

  await bot.sendMessage(
    chatId,
    `🟢 Starting Organic Volume Session!\n\n` +
    `*SOL to use:* ${solAmount}\n*Target Token:* ${project.token_name}\n\n` +
    "Your session is being prepared... (trading will start soon!)",
    { parse_mode: 'Markdown' }
  );

  // Start trading logic
  tradingEngine.startVolumeSession({
    userId,
    project,
    sessionConfig,
    bot,
    chatId
  });

  bot.answerCallbackQuery(query.id);
  return;
}

// Stop Volume Bot
if (data.startsWith('stop_volume_')) {
  const ca = data.replace('stop_volume_', '');
  if (tradingEngine.activeSessions[chatId]) {
    tradingEngine.activeSessions[chatId].stop = true;
    delete tradingEngine.activeSessions[chatId]; // <-- Add this line!
    await bot.sendMessage(chatId, "🛑 Volume bot session stopped by user.");
  } else {
    await bot.sendMessage(chatId, "No active session to stop.");
  }
  bot.answerCallbackQuery(query.id);
  return;
}

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  // Only proceed if awaiting customization input
  if (awaitingSetting[chatId] && awaitingSetting[chatId].setting) {
    const value = parseFloat(msg.text);
    if (isNaN(value) || value <= 0) {
      await bot.sendMessage(chatId, "❌ Please enter a valid positive number.");
      return;
    }
    const setting = awaitingSetting[chatId].setting;
    // Store per CA if you want (optional), otherwise per chat/user:
    if (!userVolumeConfig[chatId]) userVolumeConfig[chatId] = {};
    userVolumeConfig[chatId][setting] = value;

    // Show confirmation & return to customize menu
    let label = setting.replace("_", " ").replace(/\b\w/g, l => l.toUpperCase());
    await bot.sendMessage(chatId, `✅ Saved! ${label} set to *${value}*`, { parse_mode: 'Markdown' });

    // Re-show customize menu
    const ca = awaitingSetting[chatId].ca;
    awaitingSetting[chatId] = { ca }; // Reset for more changes

    await bot.sendMessage(
      chatId,
      "Customize your volume bot settings below. Tap a setting to change:",
      {
        reply_markup: {
          inline_keyboard: [
            [
              { text: "Set Buy Min", callback_data: "set_buy_min" },
              { text: "Set Buy Max", callback_data: "set_buy_max" }
            ],
            [
              { text: "Set Interval Min", callback_data: "set_interval_min" },
              { text: "Set Interval Max", callback_data: "set_interval_max" }
            ],
            [{ text: "⬅️ Back", callback_data: `menu_volume_${ca}` }]
          ]
        }
      }
    );
    return;
  }
});

  // Add additional handlers as needed
});
