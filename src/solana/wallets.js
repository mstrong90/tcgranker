const { Keypair, PublicKey, Connection, SystemProgram, Transaction, VersionedTransaction } = require('@solana/web3.js');
const axios = require('axios');
const config = require('../config');

// Use Helius as the default, fallback to Solana if not set
const connection = new Connection(process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com');

function createWallet() {
  const keypair = Keypair.generate();
  return {
    pubkey: keypair.publicKey.toBase58(),
    secret: Buffer.from(keypair.secretKey).toString('hex') // HEX encoding!
  };
}

async function getSolBalance(pubkey) {
  const lamports = await connection.getBalance(new PublicKey(pubkey));
  return lamports / 1e9;
}

async function getTokenBalance(pubkey, tokenMint) {
  const accounts = await connection.getParsedTokenAccountsByOwner(
    new PublicKey(pubkey),
    { mint: new PublicKey(tokenMint) }
  );
  let total = 0;
  accounts.value.forEach(({ account }) => {
    total += parseInt(account.data.parsed.info.tokenAmount.amount);
  });
  return total;
}

/**
 * Swaps all tokens from a market maker wallet to SOL using Jupiter and returns the transaction signature.
 *
 * @param {string} secretKey - The hex-encoded secret key of the market maker wallet.
 * @param {string} inputMint - The mint address of the token to swap.
 * @param {number} slippageBps - Slippage tolerance in basis points.
 * @returns {Promise<string|null>} - The swap transaction signature, or null if no tokens.
 */
async function swapTokenForSol(secretKey, inputMint, slippageBps = 100) {
  try {
    const keypair = Keypair.fromSecretKey(Buffer.from(secretKey, 'hex'));
    const userPublicKey = keypair.publicKey.toBase58();

    // Step 1: Fetch token balance
    const tokenAccounts = await connection.getTokenAccountsByOwner(keypair.publicKey, {
      mint: new PublicKey(inputMint),
    });

    if (tokenAccounts.value.length === 0) {
      return null; // No tokens to swap
    }

    const tokenAccount = tokenAccounts.value[0];
    const tokenAmountInfo = await connection.getTokenAccountBalance(tokenAccount.pubkey);
    const amount = parseInt(tokenAmountInfo.value.amount);

    if (amount === 0) {
      return null; // No tokens to swap
    }

    // Step 2: Get swap quote
    const quoteResponse = await axios.get('https://quote-api.jup.ag/v6/quote', {
      params: {
        inputMint,
        outputMint: 'So11111111111111111111111111111111111111112', // SOL
        amount,
        slippageBps,
      },
    });

    const quote = quoteResponse.data;

    // Step 3: Get swap transaction
    const swapResponse = await axios.post(
      'https://quote-api.jup.ag/v6/swap',
      {
        quoteResponse: quote,
        userPublicKey,
        wrapAndUnwrapSol: true,
      },
      {
        headers: {
          'Content-Type': 'application/json',
        },
      }
    );

    const { swapTransaction } = swapResponse.data;

    // Step 4: Deserialize and sign transaction
    const swapTransactionBuf = Buffer.from(swapTransaction, 'base64');
    const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
    transaction.sign([keypair]);

    // Step 5: Send transaction
    const signature = await connection.sendTransaction(transaction, {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
    });

    // Confirm transaction
    await connection.confirmTransaction(signature, 'confirmed');

    return signature;
  } catch (error) {
    console.error('Swap failed:', error);
    return null; // Swallow error so sellAll can continue
  }
}

/**
 * Sweeps all SOL (except rent) from a market maker wallet to the project wallet.
 */
async function withdrawAllSol(fromSecret, toAddress) {
  const fromKeypair = Keypair.fromSecretKey(Buffer.from(fromSecret, 'hex'));
  const toPubkey = new PublicKey(toAddress);

  const balanceLamports = await connection.getBalance(fromKeypair.publicKey);
  const minRentLamports = await connection.getMinimumBalanceForRentExemption(0);
  const feeLamports = 5000; // estimate for one tx

  const maxSendLamports = balanceLamports - minRentLamports - feeLamports;
  if (maxSendLamports <= 0) {
    return null;
  }

  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: fromKeypair.publicKey,
      toPubkey: toPubkey,
      lamports: maxSendLamports,
    })
  );

  const sig = await connection.sendTransaction(tx, [fromKeypair]);
  await connection.confirmTransaction(sig, 'confirmed');
  return sig;
}

/**
 * Orchestrator: For each market maker wallet,
 * 1. Swap all tokens for SOL (if any)
 * 2. Sweep all SOL to project wallet
 */
async function sellAllMarketMakers(bot, chatId, project, ca) {
  let logs = [];
  for (let mm of project.market_maker_wallets) {
    try {
      // Swap all tokens to SOL
      const sigSwap = await swapTokenForSol(mm.secret, ca, 100);
      if (sigSwap) {
        logs.push(`Swapped tokens in MM wallet \`${mm.pubkey}\`. Swap tx: [${sigSwap}](https://solscan.io/tx/${sigSwap})`);
        await connection.confirmTransaction(sigSwap, 'confirmed');
      } else {
        logs.push(`No tokens to swap in MM wallet \`${mm.pubkey}\`.`);
      }
      // Sweep all SOL to project wallet
      const sigSweep = await withdrawAllSol(mm.secret, project.project_wallet.pubkey);
      if (sigSweep) {
        logs.push(`Sent SOL to project wallet from \`${mm.pubkey}\`: [${sigSweep}](https://solscan.io/tx/${sigSweep})`);
      } else {
        logs.push(`No SOL to send from MM wallet \`${mm.pubkey}\`.`);
      }
    } catch (err) {
      logs.push(`Error processing MM wallet \`${mm.pubkey}\`: ${err.message}`);
    }
  }
  await bot.sendMessage(chatId, logs.join('\n'), { parse_mode: 'Markdown' });
}

/**
 * Distributes SOL from the project wallet to all market makers, as evenly as possible, in a single transaction.
 */
async function distributeSol(fromSecret, toAddresses) {
  const fromKeypair = Keypair.fromSecretKey(Buffer.from(fromSecret, 'hex'));
  const fromPubkey = fromKeypair.publicKey;

  const balanceLamports = await connection.getBalance(fromPubkey);
  const minRentLamports = await connection.getMinimumBalanceForRentExemption(0);

  const feeLamports = 5000;
  const nRecipients = toAddresses.length;
  const availableLamports = balanceLamports - minRentLamports - feeLamports;
  if (availableLamports <= 0) throw new Error('Not enough SOL to distribute after rent and fees.');

  const lamportsPerRecipient = Math.floor(availableLamports / nRecipients);

  const tx = new Transaction();
  for (let addr of toAddresses) {
    tx.add(
      SystemProgram.transfer({
        fromPubkey: fromPubkey,
        toPubkey: new PublicKey(addr),
        lamports: lamportsPerRecipient,
      })
    );
  }
  const sig = await connection.sendTransaction(tx, [fromKeypair]);
  await connection.confirmTransaction(sig, 'confirmed');
  return sig;
}

module.exports = {
  createWallet,
  getSolBalance,
  getTokenBalance,
  swapTokenForSol,
  withdrawAllSol,
  sellAllMarketMakers,
  distributeSol
};
