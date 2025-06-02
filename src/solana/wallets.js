// src/solana/wallets.js

const {
  Keypair,
  PublicKey,
  Connection,
  SystemProgram,
  Transaction,
  VersionedTransaction
} = require('@solana/web3.js');
const axios = require('axios');
const config = require('../config');

// ──────────────────────────────────────────────────────────────────────────────
// CONNECTION (Helius or fallback to mainnet-beta)
// ──────────────────────────────────────────────────────────────────────────────
const connection = new Connection(
  process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com'
);

/**
 * createWallet
 * Generates a new Keypair and returns { pubkey, secret }.
 */
function createWallet() {
  const keypair = Keypair.generate();
  return {
    pubkey: keypair.publicKey.toBase58(),
    secret: Buffer.from(keypair.secretKey).toString('hex')
  };
}

/**
 * getSolBalance
 * Safely returns the SOL balance (as a Number) for a given pubkey.
 * On any RPC error, returns 0.
 */
async function getSolBalance(pubkey) {
  try {
    const lamports = await connection.getBalance(new PublicKey(pubkey));
    return lamports / 1e9;
  } catch (err) {
    console.error(`Error fetching SOL balance for ${pubkey}:`, err);
    return 0;
  }
}

/**
 * getTokenBalance
 * Safely returns the token balance (as a Number, 9-decimals) for a given wallet & mint.
 * On any RPC error, returns 0.
 */
async function getTokenBalance(pubkey, tokenMint) {
  try {
    const accounts = await connection.getParsedTokenAccountsByOwner(
      new PublicKey(pubkey),
      { mint: new PublicKey(tokenMint) }
    );
    let totalRaw = 0;
    for (let { account } of accounts.value) {
      const raw = parseInt(account.data.parsed.info.tokenAmount.amount, 10);
      totalRaw += isNaN(raw) ? 0 : raw;
    }
    return totalRaw / 1e9;
  } catch (err) {
    console.error(`Error fetching token balance for ${pubkey} / ${tokenMint}:`, err);
    return 0;
  }
}

/**
 * swapTokenForSol
 * Swaps all tokens from a market maker wallet to SOL using Jupiter.
 * Returns the tx signature string, or "" if nothing to swap or on error.
 */
async function swapTokenForSol(secretKey, inputMint, slippageBps = 100) {
  try {
    const keypair = Keypair.fromSecretKey(Buffer.from(secretKey, 'hex'));
    const userPublicKey = keypair.publicKey.toBase58();

    // 1) Fetch token accounts for this mint
    const tokenAccounts = await connection.getTokenAccountsByOwner(
      keypair.publicKey,
      { mint: new PublicKey(inputMint) }
    );
    if (tokenAccounts.value.length === 0) return "";

    const tokenAccountPubkey = tokenAccounts.value[0].pubkey;
    const tokenAmountInfo = await connection.getTokenAccountBalance(tokenAccountPubkey);
    const amount = parseInt(tokenAmountInfo.value.amount, 10);
    if (amount === 0) return "";

    // 2) Get swap quote for token → SOL
    const quoteResponse = await axios.get('https://quote-api.jup.ag/v6/quote', {
      params: {
        inputMint,
        outputMint: 'So11111111111111111111111111111111111111112', // SOL
        amount,
        slippageBps
      }
    });
    const quote = quoteResponse.data;

    // 3) Get swap transaction payload
    const swapResponse = await axios.post(
      'https://quote-api.jup.ag/v6/swap',
      {
        quoteResponse: quote,
        userPublicKey,
        wrapAndUnwrapSol: true
      },
      { headers: { 'Content-Type': 'application/json' } }
    );
    const { swapTransaction } = swapResponse.data;
    const swapBuf = Buffer.from(swapTransaction, 'base64');
    const transaction = VersionedTransaction.deserialize(swapBuf);

    // 4) Sign and send
    transaction.sign([keypair]);
    const signature = await connection.sendTransaction(transaction, {
      skipPreflight: false,
      preflightCommitment: 'confirmed'
    });
    await connection.confirmTransaction(signature, 'confirmed');
    return signature;
  } catch (error) {
    console.error('Swap failed:', error);
    return "";
  }
}

/**
 * withdrawAllSol
 * Drains all SOL (minus exact fee) from fromSecret to toAddress.
 * Returns tx signature string, or "" if not enough balance or on error.
 */
async function withdrawAllSol(fromSecret, toAddress) {
  try {
    const fromKeypair = Keypair.fromSecretKey(Buffer.from(fromSecret, 'hex'));
    const toPubkey = new PublicKey(toAddress);

    // 1) Fetch full balance in lamports
    const balanceLamports = await connection.getBalance(fromKeypair.publicKey);

    // 2) Estimate exact fee for a 0-lamport transfer
    const { blockhash } = await connection.getLatestBlockhash();
    const dummyTx = new Transaction();
    dummyTx.recentBlockhash = blockhash;
    dummyTx.feePayer = fromKeypair.publicKey;
    dummyTx.add(
      SystemProgram.transfer({
        fromPubkey: fromKeypair.publicKey,
        toPubkey,
        lamports: 0
      })
    );
    const feeInfo = await connection.getFeeForMessage(dummyTx.compileMessage());
    const exactFee = feeInfo.value || 0;

    // 3) Compute lamports to send
    const lamportsToSend = balanceLamports - exactFee;
    if (lamportsToSend <= 0) return "";

    // 4) Build the “real” transfer
    const tx = new Transaction();
    tx.recentBlockhash = blockhash;
    tx.feePayer = fromKeypair.publicKey;
    tx.add(
      SystemProgram.transfer({
        fromPubkey: fromKeypair.publicKey,
        toPubkey,
        lamports: lamportsToSend
      })
    );

    // 5) Sign, send, confirm
    const signature = await connection.sendTransaction(tx, [fromKeypair]);
    await connection.confirmTransaction(signature, 'confirmed');
    return signature;
  } catch (err) {
    console.error(`Error in withdrawAllSol:`, err);
    return "";
  }
}

/**
 * sellAllMarketMakers
 * For each market-maker wallet:
 *   1) swap all tokens → SOL
 *   2) drain all SOL → project wallet (minus exact fee)
 * Sends a log message to the Telegram chat.
 */
async function sellAllMarketMakers(bot, chatId, project, ca) {
  const logs = [];
  for (const mm of project.market_maker_wallets) {
    try {
      const sigSwap = await swapTokenForSol(mm.secret, ca, 100);
      if (sigSwap) {
        logs.push(
          `Swapped tokens in MM wallet \`${mm.pubkey}\`. Swap tx: [${sigSwap}](https://solscan.io/tx/${sigSwap})`
        );
        await connection.confirmTransaction(sigSwap, 'confirmed');
      } else {
        logs.push(`No tokens to swap in MM wallet \`${mm.pubkey}\`.`);
      }

      const sigSweep = await withdrawAllSol(mm.secret, project.project_wallet.pubkey);
      if (sigSweep) {
        logs.push(
          `Drained SOL from \`${mm.pubkey}\` to project wallet: [${sigSweep}](https://solscan.io/tx/${sigSweep})`
        );
      } else {
        logs.push(`No SOL available to send from MM wallet \`${mm.pubkey}\`.`);
      }
    } catch (err) {
      logs.push(`Error processing MM wallet \`${mm.pubkey}\`: ${err.message}`);
    }
  }
  await bot.sendMessage(chatId, logs.join('\n'), { parse_mode: 'Markdown' });
}

/**
 * distributeSol
 * Splits all available SOL (minus rent-exempt minimums) among recipients.
 * Ensures each new account is funded with rentExempt lamports.
 * Returns tx signature string, or "" if insufficient funds or on error.
 */
async function distributeSol(fromSecret, toAddresses) {
  try {
    const fromKeypair = Keypair.fromSecretKey(Buffer.from(fromSecret, 'hex'));
    const fromPubkey = fromKeypair.publicKey;

    // 1) Fetch full balance
    const balanceLamports = await connection.getBalance(fromPubkey);

    // 2) Determine rent-exempt minimum (for a zero-byte account)
    const rentExempt = await connection.getMinimumBalanceForRentExemption(0);

    // 3) Separate recipients into “new” vs “existing” accounts
    const newRecipients = [];
    const existingRecipients = [];
    for (const addr of toAddresses) {
      const accountInfo = await connection.getAccountInfo(new PublicKey(addr));
      if (accountInfo === null) {
        newRecipients.push(addr);
      } else {
        existingRecipients.push(addr);
      }
    }

    // 4) Build dummyTx to estimate exact fee
    const { blockhash } = await connection.getLatestBlockhash();
    const dummyTx = new Transaction();
    dummyTx.recentBlockhash = blockhash;
    dummyTx.feePayer = fromPubkey;
    toAddresses.forEach((addr) => {
      dummyTx.add(
        SystemProgram.transfer({
          fromPubkey,
          toPubkey: new PublicKey(addr),
          lamports: 0
        })
      );
    });
    const feeInfo = await connection.getFeeForMessage(dummyTx.compileMessage());
    const exactFee = feeInfo.value || 0;

    // 5) Compute total required rent for new accounts
    const requiredRent = rentExempt * newRecipients.length;

    // 6) Compute lamports available for “actual distribution”
    const availableLamports = balanceLamports - exactFee - requiredRent;
    if (availableLamports <= 0) {
      console.error('Not enough funds: rent + fee > balance');
      return "";
    }

    // 7) Determine share for each recipient (even split)
    const totalCount = toAddresses.length;
    const share = Math.floor(availableLamports / totalCount);
    let remainder = availableLamports - share * totalCount;

    // 8) Build the actual transaction
    const tx = new Transaction();
    tx.recentBlockhash = blockhash;
    tx.feePayer = fromPubkey;

    toAddresses.forEach((addr, idx) => {
      let lamportsToSend = share;
      if (newRecipients.includes(addr)) {
        // top up to rentExempt
        lamportsToSend += rentExempt;
      }
      // add leftover dust to the first recipient
      if (idx === 0 && remainder > 0) {
        lamportsToSend += remainder;
      }
      tx.add(
        SystemProgram.transfer({
          fromPubkey,
          toPubkey: new PublicKey(addr),
          lamports: lamportsToSend
        })
      );
    });

    // 9) Sign, send, confirm
    const signature = await connection.sendTransaction(tx, [fromKeypair]);
    await connection.confirmTransaction(signature, 'confirmed');
    return signature;
  } catch (err) {
    console.error(`Error in distributeSol:`, err);
    return "";
  }
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
