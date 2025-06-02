// src/config/volume.js
function buildVolumeConfig({ ca, solAmount }) {
  return {
    mode: "organic",
    token_mint: ca,
    wsol: "So11111111111111111111111111111111111111112",
    buy_min_by_sol: 0.006,
    buy_max_by_sol: 0.006,
    sell_min_by_sol: 0.006,
    sell_max_by_sol: 0.006,
    buy_slippage_bps: 50,
    sell_slippage_bps: 50,
    interval_min: 15,
    interval_max: 15,
    buy_ratio: 50,
    sell_ratio: 50,
    limit_trades: 999999,
    min_sol_balance: 0.001,
    min_sol_balance_sell: 0.001,
    timeout_by_seconds: 180,
    retry_number: 3,
    title: "Organic Volume Run"
  };
}

module.exports = { buildVolumeConfig };
