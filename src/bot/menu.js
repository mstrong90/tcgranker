// src/bot/menu.js

const db = require('../db/db');
const wallets = require('../solana/wallets');

//////////////////////////////////////////////////////////////
// Helpers
//////////////////////////////////////////////////////////////

function shorten(addr) {
  return addr.slice(0, 4) + '...' + addr.slice(-4);
}

function trimSol(sol) {
  return parseFloat(sol)
    .toFixed(9)
    .replace(/\.?0+$/, '');
}

function formatToken(uiAmount) {
  const n = Number(uiAmount) || 0;
  return n.toLocaleString('en-US', {
    minimumFractionDigits: 9,
    maximumFractionDigits: 9
  });
}

//////////////////////////////////////////////////////////////
// Existing: handleWalletsMenu (for Volume Bot)
//////////////////////////////////////////////////////////////
async function handleWalletsMenu(bot, chatId, ca, userId) {
  let project = db.getProject(userId, ca);
  if (!project) {
    await bot.sendMessage(chatId, 'Project not found.');
    return;
  }

  let message = `👛 *Project Wallets*\n\n`;

  // PROJECT WALLET
  if (!project.project_wallet) {
    message += `*Project Wallet:* Not yet created\n\n`;
  } else {
    const sol = await wallets.getSolBalance(project.project_wallet.pubkey);
    message += `*Project Wallet:*\n`;
    message += `• Address: \`${project.project_wallet.pubkey}\`\n`;
    message += `• SOL: \`${trimSol(sol)}\`\n\n`;
  }

  // MARKET MAKER WALLETS
  if (!project.market_maker_wallets || project.market_maker_wallets.length === 0) {
    message += `*Market Maker Wallets:* None created\n`;
  } else {
    message += `*Market Maker Wallets:*\n`;
    for (let w of project.market_maker_wallets) {
      const sol = await wallets.getSolBalance(w.pubkey);
      const tokenBal = await wallets.getTokenBalance(w.pubkey, ca);
      message += `• Address: \`${w.pubkey}\` | SOL: \`${trimSol(sol)}\` | Token: \`${tokenBal}\`\n\n`;
    }
  }

  // INLINE BUTTONS
  let buttons = [];
  if (!project.project_wallet) {
    buttons.push([
      { text: '➕ Generate Project Wallet', callback_data: `gen_project_wallet_${ca}` }
    ]);
  }
  if (!project.market_maker_wallets || project.market_maker_wallets.length === 0) {
    buttons.push([
      { text: '➕ Generate Market Makers', callback_data: `gen_market_makers_${ca}` }
    ]);
  }
  if (project.project_wallet && project.market_maker_wallets && project.market_maker_wallets.length > 0) {
    buttons.push([
      { text: '💸 Sell All', callback_data: `sell_all_${ca}` }
    ]);
  }
  if (project.project_wallet) {
    buttons.push([
      { text: '🏦 Withdraw', callback_data: `withdraw_${ca}` }
    ]);
  }
  if (
    project.project_wallet &&
    project.market_maker_wallets &&
    project.market_maker_wallets.length > 0
  ) {
    buttons.push([
      { text: '🔀 Distribute', callback_data: `distribute_${ca}` }
    ]);
  }
  buttons.push([
    { text: '🛒 Buy More Makers', callback_data: `buy_more_makers_${ca}` }
  ]);
  buttons.push([
    { text: '🔄 Refresh', callback_data: `refresh_wallets_${ca}` },
    { text: '⬅️ Back',    callback_data: `back_main_${ca}` }
  ]);

  await bot.sendMessage(chatId, message, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: buttons }
  });
}

//////////////////////////////////////////////////////////////
// Existing: showMainMenu
//////////////////////////////////////////////////////////////
async function showMainMenu(bot, chatId, userId, ca) {
  await bot.sendMessage(
    chatId,
    "🌟 *Main Menu*\n\nWhat would you like to do?",
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "📊 Volume Bot", callback_data: `menu_volume_${ca}` }],
          [{ text: "🚀 Rank Bot",   callback_data: `menu_rank_${ca}` }],
          [{ text: "📄 My Projects", callback_data: "my_projects" }]
        ]
      }
    }
  );
}

//////////////////////////////////////////////////////////////
// NEW: handleRankMenu
//
// Shows an explanation of what Rank Bot does, plus four buttons:
//   👛 Wallets ⚙️ Customize Settings ▶️ Start Rank Bot ⬅️ Back
//////////////////////////////////////////////////////////////
async function handleRankMenu(bot, chatId, ca, userId) {
  // 1) If project doesn’t exist, warn
  const project = db.getProject(userId, ca);
  if (!project) {
    await bot.sendMessage(chatId, "Project not found.");
    return;
  }

  // 2) Explanation text
  const message =
    `🚩 *Rank Bot*\n\n` +
    `The Rank Bot automatically simulates buy-and-sell orders to maintain\n` +
    `a minimum number of orders on the orderbook for your token. This helps\n` +
    `keep liquidity tight, create better on‐chain price discovery, and support\n` +
    `traders who rely on a healthy orderbook.\n\n` +
    
    `Choose one of the options below to continue:`;

  // 3) Four inline‐keyboard buttons
  const buttons = [
    [ { text: "👛 Wallets",            callback_data: `rank_wallets_${ca}` } ],
    [ { text: "⚙️ Customize Settings", callback_data: `rank_customize_${ca}` } ],
    [ { text: "▶️ Start Rank Bot",      callback_data: `rank_start_${ca}` } ],
    [ { text: "⬅️ Back",               callback_data: `back_main_${ca}` } ]
  ];

  await bot.sendMessage(chatId, message, {
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: buttons }
  });
}

//////////////////////////////////////////////////////////////
// NEW: handleRankWalletsMenu
//
// Similar to handleWalletsMenu but for Rank Bot. Shows “Generate Project Wallet”
// and “Generate Ranker Wallets” if they don’t exist; otherwise shows balances.
//////////////////////////////////////////////////////////////
async function handleRankWalletsMenu(bot, chatId, ca, userId) {
  const project = db.getProject(userId, ca);
  if (!project) {
    await bot.sendMessage(chatId, "Project not found.");
    return;
  }

  let message = `👛 *Rank Bot – Wallets*\n\n`;

  // PROJECT WALLET
  if (!project.project_wallet) {
    message += `*Project Wallet:* Not yet created\n\n`;
  } else {
    const sol = await wallets.getSolBalance(project.project_wallet.pubkey);
    message += `*Project Wallet:*\n`;
    message += `• Address: \`${project.project_wallet.pubkey}\`\n`;
    message += `• SOL Balance: \`${trimSol(sol)}\`\n\n`;
  }

  // RANKER WALLETS
  if (!project.ranker_wallets || project.ranker_wallets.length === 0) {
    message += `*Ranker Wallets:* None created\n`;
  } else {
    message += `*Ranker Wallets (50):*\n`;
    for (let w of project.ranker_wallets) {
      const sol = await wallets.getSolBalance(w.pubkey);
      message += `• ${shorten(w.pubkey)} | SOL: \`${trimSol(sol)}\`\n`;
    }
    message += `\n`;
  }

  // INLINE BUTTONS
  let buttons = [];
  // Generate Project Wallet if missing
  if (!project.project_wallet) {
    buttons.push([
      { text: '➕ Generate Project Wallet', callback_data: `gen_project_wallet_${ca}` }
    ]);
  }
  // Generate 50 Ranker Wallets if missing
  if (!project.ranker_wallets || project.ranker_wallets.length === 0) {
    buttons.push([
      { text: '➕ Generate Ranker Wallets', callback_data: `gen_ranker_wallets_${ca}` }
    ]);
  }

  // If both exist, show a “Refresh” button so you can re‐check balances
  if (project.project_wallet && project.ranker_wallets && project.ranker_wallets.length > 0) {
    buttons.push([
      { text: '🔄 Refresh', callback_data: `rank_wallets_${ca}` }
    ]);
  }

  // Always allow going back
  buttons.push([
    { text: '⬅️ Back', callback_data: `menu_rank_${ca}` }
  ]);

  await bot.sendMessage(chatId, message, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: buttons }
  });
}

module.exports = {
  handleWalletsMenu,
  showMainMenu,
  handleRankMenu,
  handleRankWalletsMenu
};
