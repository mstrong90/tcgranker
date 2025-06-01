// src/config/volume.js
function buildVolumeConfig({ ca, solAmount }) {
  return {
    mode: "organic",
    token_mint: ca,
    wsol: "So11111111111111111111111111111111111111112",
    sol_per_session: solAmount,
    volume_target: solAmount * 30000, // Adjust as needed
    buy_min_by_sol: 0.00065,
    buy_max_by_sol: 0.00065,
    sell_min_by_sol: 0.00065,
    sell_max_by_sol: 0.00065,
    buy_slippage_bps: 50,
    sell_slippage_bps: 50,
    interval_min: 1,
    interval_max: 1,
    buy_ratio: 50,
    sell_ratio: 50,
    limit_trades: 999999,
    min_sol_balance: 0.003,
    min_sol_balance_sell: 0.003,
    timeout_by_seconds: 180,
    retry_number: 3,
    title: "Organic Volume Run"
  };
}

module.exports = { buildVolumeConfig };
