const { Keypair, PublicKey, Connection, VersionedTransaction } = require('@solana/web3.js');
const axios = require('axios');
const config = require('../config');

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

const activeSessions = {}; // { [chatId]: { stop: false } }

// Fetch SOL/USD price from CoinGecko
async function getSolUsdPrice() {
  try {
    const res = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
    return res.data.solana.usd;
  } catch {
    return null; // fallback if request fails
  }
}

// Helper: Sleep
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Fetch decimals for any SPL token mint
async function getMintDecimals(mintAddress) {
  const connection = getHeliusConnection();
  try {
    const mintPubkey = new PublicKey(mintAddress);
    const mintAccount = await connection.getParsedAccountInfo(mintPubkey);
    if (
      mintAccount &&
      mintAccount.value &&
      mintAccount.value.data &&
      mintAccount.value.data.parsed &&
      mintAccount.value.data.parsed.info &&
      typeof mintAccount.value.data.parsed.info.decimals !== 'undefined'
    ) {
      return mintAccount.value.data.parsed.info.decimals;
    }
  } catch (e) {
    // ignore
  }
  // Default fallback (most SPL tokens)
  return 9;
}

// Get SOL balance for wallet
async function getSolBalance(pubkey) {
  const connection = getHeliusConnection();
  return (await connection.getBalance(new PublicKey(pubkey))) / 1e9;
}

// Get token balance for wallet
async function getTokenBalance(pubkey, tokenMint) {
  const connection = getHeliusConnection();
  const accounts = await connection.getParsedTokenAccountsByOwner(
    new PublicKey(pubkey),
    { mint: new PublicKey(tokenMint) }
  );
  let total = 0;
  accounts.value.forEach(({ account }) => {
    total += parseFloat(account.data.parsed.info.tokenAmount.uiAmount || 0);
  });
  return total;
}

// Jupiter swap SOL->Token or Token->SOL
async function jupiterSwap({ secret, inputMint, outputMint, amount, slippageBps }) {
  const connection = getHeliusConnection();
  try {
    // Add logging of params for every attempted swap
    console.log('Jupiter swap params:', {
      inputMint,
      outputMint,
      amount,
      slippageBps,
      // user: Keypair.fromSecretKey(Buffer.from(secret, 'hex')).publicKey.toBase58().slice(0, 8) + '...'
    });

    const keypair = Keypair.fromSecretKey(Buffer.from(secret, 'hex'));
    const userPublicKey = keypair.publicKey.toBase58();

    // 1. Jupiter Quote (amount in smallest units)
    const quoteRes = await axios.get('https://quote-api.jup.ag/v6/quote', {
      params: {
        inputMint,
        outputMint,
        amount,
        slippageBps,
      },
    });
    const quote = quoteRes.data;

    if (!quote || !quote.outAmount || quote.inAmount === '0') {
      throw new Error("Jupiter could not provide a quote.");
    }

    // 2. Jupiter Swap
    const swapRes = await axios.post(
      'https://quote-api.jup.ag/v6/swap',
      {
        quoteResponse: quote,
        userPublicKey,
        wrapAndUnwrapSol: true,
      },
      {
        headers: { 'Content-Type': 'application/json' },
      }
    );
    const { swapTransaction } = swapRes.data;
    const txBuf = Buffer.from(swapTransaction, 'base64');
    const tx = VersionedTransaction.deserialize(txBuf);

    tx.sign([keypair]);

    const sig = await connection.sendTransaction(tx, { skipPreflight: false, preflightCommitment: 'confirmed' });
    await connection.confirmTransaction(sig, 'confirmed');

    return sig;
  } catch (e) {
    // Add detailed error logging for API errors
    if (e.response && e.response.data) {
      console.error('Jupiter swap error details:', e.response.data);
      throw new Error("Jupiter swap error: " + JSON.stringify(e.response.data));
    }
    throw new Error("Jupiter swap error: " + (e.message || e));
  }
}

async function startVolumeSession({ userId, project, sessionConfig, bot, chatId }) {
  const mmWallets = project.market_maker_wallets;
  const tokenMint = sessionConfig.token_mint;
  const wsolMint = sessionConfig.wsol;

  // Fetch decimals for both mints (do once per session!)
  const solDecimals = 9; // Always 9 for SOL/WSOL
  const tokenDecimals = await getMintDecimals(tokenMint);

  let totalTrades = 0;
  let totalVolume = 0;
  let running = true;
  let lastWalletIdx = -1;

  activeSessions[chatId] = { stop: false };

  await bot.sendMessage(chatId, `⏳ Volume bot is now running! You can stop at any time with the button below:`, {
    reply_markup: {
      inline_keyboard: [
        [{ text: "🛑 Stop Bot", callback_data: `stop_volume_${project.ca}` }]
      ]
    }
  });

  let remainingSol = sessionConfig.sol_per_session;

  while (
    running &&
    activeSessions[chatId] &&
    !activeSessions[chatId].stop &&
    totalTrades < sessionConfig.limit_trades &&
    remainingSol > sessionConfig.min_sol_balance
  ) {
    // Pick a wallet that isn't the last one (if possible)
    let availableWallets = mmWallets.slice();
    if (mmWallets.length > 1 && lastWalletIdx !== -1) {
      availableWallets.splice(lastWalletIdx, 1);
    }
    let walletIdx = Math.floor(Math.random() * availableWallets.length);
    if (mmWallets.length > 1 && lastWalletIdx !== -1 && walletIdx >= lastWalletIdx) walletIdx += 1;

    const mm = mmWallets[walletIdx];
    lastWalletIdx = walletIdx;

    // Random trade direction
    const isBuy = Math.random() < sessionConfig.buy_ratio / 100;

    // Trade amount
    let tradeAmount;
    if (isBuy) {
      tradeAmount = Math.random() * (sessionConfig.buy_max_by_sol - sessionConfig.buy_min_by_sol) + sessionConfig.buy_min_by_sol;
      tradeAmount = Number(tradeAmount.toFixed(4));
      // Check up-to-date SOL balance with fee buffer
      const solBal = await getSolBalance(mm.pubkey);
      if (solBal < tradeAmount + sessionConfig.min_sol_balance + 0.001) {
        await sleep(1000);
        continue;
      }
    } else {
      // Sell 100% of balance (refresh live)
      tradeAmount = await getTokenBalance(mm.pubkey, tokenMint);
      if (tradeAmount < sessionConfig.min_sol_balance_sell || tradeAmount === 0) {
        await sleep(1000);
        continue;
      }
    }

    // Prepare Jupiter params
    let inputMint, outputMint, inputAmount, slippageBps;
    if (isBuy) {
      inputMint = wsolMint;
      outputMint = tokenMint;
      inputAmount = Math.floor(tradeAmount * Math.pow(10, solDecimals));
      slippageBps = sessionConfig.buy_slippage_bps;
    } else {
      inputMint = tokenMint;
      outputMint = wsolMint;
      inputAmount = Math.floor(tradeAmount * Math.pow(10, tokenDecimals));
      slippageBps = sessionConfig.sell_slippage_bps;
    }

    // Log trade
    console.log(`Trade: ${isBuy ? 'BUY' : 'SELL'} ${tradeAmount} ${isBuy ? 'SOL' : 'Token'}`);

    // Execute trade
    try {
      const txSig = await jupiterSwap({
        secret: mm.secret,
        inputMint,
        outputMint,
        amount: inputAmount,
        slippageBps,
      });

      totalTrades++;
      if (isBuy) {
        remainingSol -= tradeAmount;
        totalVolume += tradeAmount;
      }

      // Hyperlink for transaction
      const txUrl = `https://solscan.io/tx/${txSig}`;
      const txLink = `[View Tx](${txUrl})`;

      // Send message for every trade, always with Stop button and hyperlink
      await bot.sendMessage(
        chatId,
        `${isBuy ? 'BUY' : 'SELL'} | Amount: ${tradeAmount} ${isBuy ? 'SOL' : 'Token'}\n` +
        `${txLink}\n` +
        `Progress: ${totalTrades} trades completed.`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: "🛑 Stop Bot", callback_data: `stop_volume_${project.ca}` }]
            ]
          }
        }
      );
    } catch (e) {
      await bot.sendMessage(chatId, `❌ Trade failed: ${e.message}`);
    }

    // Wait a random interval per config for "organic" effect
    const waitTime = Math.random() * (sessionConfig.interval_max - sessionConfig.interval_min) + sessionConfig.interval_min;
    await sleep(waitTime * 1000);
  }

  // Fetch SOL price for volume in USD
  const solPrice = await getSolUsdPrice();
  const usdVol = solPrice ? (totalVolume * solPrice).toFixed(2) : "N/A";

  await bot.sendMessage(
    chatId,
    `✅ Volume session complete!\n\n` +
    `Total trades: ${totalTrades}\n` +
    `Total volume generated: *${totalVolume.toFixed(4)} SOL* (~$${usdVol} USD)`,
    { parse_mode: 'Markdown' }
  );
  delete activeSessions[chatId]; // Cleanup AFTER session finishes
}

module.exports = {
  getSolBalance,
  startVolumeSession,
  activeSessions,
};
