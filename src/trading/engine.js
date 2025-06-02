// src/solana/engine.js

const {
  Keypair,
  PublicKey,
  Connection,
  VersionedTransaction
} = require('@solana/web3.js');
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
    return null;
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
  } catch {
    // ignore
  }
  return 9;
}

// Get SOL balance for wallet
async function getSolBalance(pubkey) {
  const connection = getHeliusConnection();
  const lamports = await connection.getBalance(new PublicKey(pubkey));
  return lamports / 1e9;
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
    console.log('Jupiter swap params:', { inputMint, outputMint, amount, slippageBps });

    const keypair = Keypair.fromSecretKey(Buffer.from(secret, 'hex'));
    const userPublicKey = keypair.publicKey.toBase58();

    // 1. Jupiter Quote
    const quoteRes = await axios.get('https://quote-api.jup.ag/v6/quote', {
      params: { inputMint, outputMint, amount, slippageBps }
    });
    const quote = quoteRes.data;
    if (!quote || !quote.outAmount || quote.inAmount === '0') {
      throw new Error("Jupiter could not provide a quote.");
    }

    // 2. Jupiter Swap
    const swapRes = await axios.post(
      'https://quote-api.jup.ag/v6/swap',
      { quoteResponse: quote, userPublicKey, wrapAndUnwrapSol: true },
      { headers: { 'Content-Type': 'application/json' } }
    );
    const { swapTransaction } = swapRes.data;
    const txBuf = Buffer.from(swapTransaction, 'base64');
    const tx = VersionedTransaction.deserialize(txBuf);

    tx.sign([keypair]);
    const sig = await connection.sendTransaction(tx, { skipPreflight: false, preflightCommitment: 'confirmed' });
    await connection.confirmTransaction(sig, 'confirmed');
    return sig;
  } catch (e) {
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

  const solDecimals = 9;
  const tokenDecimals = await getMintDecimals(tokenMint);

  let totalTrades = 0;
  let totalVolume = 0;
  let lastWalletIdx = -1;

  activeSessions[chatId] = { stop: false };

  await bot.sendMessage(chatId, `⏳ Volume bot is now running! You can stop at any time:`, {
    reply_markup: { inline_keyboard: [[{ text: "🛑 Stop Bot", callback_data: `stop_volume_${project.ca}` }]] }
  });

  while (
    activeSessions[chatId] &&
    !activeSessions[chatId].stop &&
    totalTrades < sessionConfig.limit_trades
  ) {
    // 1) Build list of wallets with SOL >= min_sol_balance
    const fundedWallets = [];
    for (const mm of mmWallets) {
      const solBal = await getSolBalance(mm.pubkey);
      if (solBal >= sessionConfig.min_sol_balance) {
        fundedWallets.push({ ...mm, solBal });
      }
    }
    // 2) If none remain, break
    if (fundedWallets.length === 0) break;

    // 3) Pick next wallet (round-robin)
    lastWalletIdx = (lastWalletIdx + 1) % fundedWallets.length;
    const chosen = fundedWallets[lastWalletIdx];

    // 4) Decide trade type
    const isBuy = Math.random() < sessionConfig.buy_ratio / 100;
    let tradeAmount;

    if (isBuy) {
      tradeAmount = Math.random() * (sessionConfig.buy_max_by_sol - sessionConfig.buy_min_by_sol) + sessionConfig.buy_min_by_sol;
      tradeAmount = Number(tradeAmount.toFixed(4));
      const solBal = chosen.solBal;
      if (solBal < tradeAmount + sessionConfig.min_sol_balance + 0.001) {
        await sleep(1000);
        continue;
      }
    } else {
      tradeAmount = await getTokenBalance(chosen.pubkey, tokenMint);
      if (tradeAmount < sessionConfig.min_sol_balance_sell || tradeAmount === 0) {
        await sleep(1000);
        continue;
      }
    }

    // 5) Build Jupiter parameters
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

    // 6) Execute trade
    try {
      const txSig = await jupiterSwap({
        secret: chosen.secret,
        inputMint,
        outputMint,
        amount: inputAmount,
        slippageBps
      });

      totalTrades++;
      if (isBuy) totalVolume += tradeAmount;

      const txUrl = `https://solscan.io/tx/${txSig}`;
      await bot.sendMessage(
        chatId,
        `${isBuy ? 'BUY' : 'SELL'} | Amount: ${tradeAmount} ${isBuy ? 'SOL' : 'Token'}\n` +
        `[View Tx](${txUrl})\n` +
        `Trades: ${totalTrades}`,
        {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [[{ text: "🛑 Stop Bot", callback_data: `stop_volume_${project.ca}` }]] }
        }
      );
    } catch (e) {
      await bot.sendMessage(chatId, `❌ Trade failed: ${e.message}`);
    }

    // 7) Wait a random interval
    const waitTime = Math.random() * (sessionConfig.interval_max - sessionConfig.interval_min) + sessionConfig.interval_min;
    await sleep(waitTime * 1000);
  }

  // 8) Session complete
  const solPrice = await getSolUsdPrice();
  const usdVol = solPrice ? (totalVolume * solPrice).toFixed(2) : "N/A";

  await bot.sendMessage(
    chatId,
    `✅ Volume session complete!\n\n` +
    `Total trades: ${totalTrades}\n` +
    `Total volume generated: *${totalVolume.toFixed(4)} SOL* (~$${usdVol} USD)`,
    { parse_mode: 'Markdown' }
  );
  delete activeSessions[chatId];
}

module.exports = {
  getSolBalance,
  startVolumeSession,
  activeSessions
};
