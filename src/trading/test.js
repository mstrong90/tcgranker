const { sendSol, getSolBalance, runMarketMakerCycle, loadKeypair } = require('./engine');

// TEST: Replace with real values or use .env
const TEST_PRIVATE_KEY = process.env.MARKET_MAKER_PRIVATE_KEY; // Must be a JSON array string!
const TEST_WALLET = process.env.PROJECT_WALLET; // Public address

async function main() {
  // Test balance fetch
  const bal = await getSolBalance(TEST_WALLET);
  console.log('SOL balance of test wallet:', bal);

  // Test running market maker logic
  await runMarketMakerCycle();
}

main();
