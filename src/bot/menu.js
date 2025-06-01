// src/bot/menu.js
const db = require('../db/db');
const wallets = require('../solana/wallets');

function shorten(addr) {
  return addr.slice(0, 4) + '...' + addr.slice(-4);
}

function trimSol(sol) {
  return parseFloat(sol).toFixed(9).replace(/\.?0+$/, '');
}

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
    message += `Address: \`${project.project_wallet.pubkey}\`\n`; // Full address, no shorten()
    message += `SOL: \`${trimSol(sol)}\`\n\n`;
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
    buttons.push([{ text: '➕ Generate Project Wallet', callback_data: `gen_project_wallet_${ca}` }]);
  }
  if (!project.market_maker_wallets || project.market_maker_wallets.length === 0) {
    buttons.push([{ text: '➕ Generate Market Makers', callback_data: `gen_market_makers_${ca}` }]);
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

  // Always add Refresh and Back at the end
  buttons.push([
    { text: '🔄 Refresh', callback_data: `refresh_wallets_${ca}` },
    { text: '⬅️ Back', callback_data: `back_main_${ca}` }
  ]);

  await bot.sendMessage(chatId, message, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: buttons }
  });
}

async function showMainMenu(bot, chatId, userId, ca) {
  await bot.sendMessage(
    chatId,
    "🌟 *Main Menu*\n\nWhat would you like to do?",
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "📊 Volume Bot", callback_data: `menu_volume_${ca}` }],
          [{ text: "🚀 Rank Bot", callback_data: `menu_rank_${ca}` }],
          [{ text: '📄 My Projects', callback_data: 'my_projects' }]
        ]
      }
    }
  );
}


module.exports = {
  handleWalletsMenu,
  showMainMenu
};
