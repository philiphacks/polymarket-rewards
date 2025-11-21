import fs from "fs";

const HISTORY_FILE = "vol_history.json";
const WINDOW_SIZE = 60; // Keep last 60 minutes
const MIN_DATA_POINTS = 10; // Need at least 10 mins to trust the calc

// Default floors (Safety net if history is empty)
const FALLBACK_SIGMA_USD = {
  BTC: 70,
  ETH: 4.0,
  SOL: 0.20,
  XRP: 0.0035,
};

let history = {}; // Structure: { "BTC": [{ ts: 123, price: 95000 }, ...], ... }

// 1. Load History on Startup
function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      history = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
    }
  } catch (e) {
    console.error("[VOL] Failed to load history, starting fresh.", e);
  }
}

// 2. Save History (Call this periodically)
function saveHistory() {
  try {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history));
  } catch (e) {
    console.error("[VOL] Failed to save history.", e);
  }
}

// 3. Add a price point (Call this once per minute)
function updatePriceHistory(symbol, price) {
  if (!history[symbol]) history[symbol] = [];
  
  const now = Date.now();
  const lastEntry = history[symbol][history[symbol].length - 1];

  // Only add if 1 minute has passed since last entry
  if (lastEntry && now - lastEntry.ts < 58 * 1000) {
    return; 
  }

  history[symbol].push({ ts: now, price });

  // Trim to window size
  if (history[symbol].length > WINDOW_SIZE) {
    history[symbol] = history[symbol].slice(-WINDOW_SIZE);
  }
  
  saveHistory();
}

// 4. The Core Math: Calculate Standard Deviation of Log Returns
function getRealizedVolatility(symbol, currentPrice) {
  const data = history[symbol];

  // Fallback if not enough data
  if (!data || data.length < MIN_DATA_POINTS) {
    // console.log(`[VOL] ${symbol}: Using fallback (data points: ${data ? data.length : 0})`);
    return FALLBACK_SIGMA_USD[symbol];
  }

  // Calculate Log Returns: ln(price / prevPrice)
  const returns = [];
  for (let i = 1; i < data.length; i++) {
    const r = Math.log(data[i].price / data[i-1].price);
    returns.push(r);
  }

  // Calculate Mean of returns (usually close to 0 in short timeframes, but good to be precise)
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;

  // Calculate Variance
  const variance = returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / (returns.length - 1);

  // Standard Deviation of Returns (Percentage Volatility per Minute)
  const stdDevReturns = Math.sqrt(variance);

  // Convert to USD Volatility: Current Price * % Vol
  const sigmaUSD = currentPrice * stdDevReturns;

  // Safety: Don't let it drop BELOW the fallback floor (prevents dividing by zero in flat markets)
  return Math.max(sigmaUSD, FALLBACK_SIGMA_USD[symbol]);
}

// 5. Get "Vol Ratio" (Are we in a high vol regime?)
function getVolRegimeRatio(symbol, currentSigmaUSD) {
  const floor = FALLBACK_SIGMA_USD[symbol];
  if (!floor) return 1;
  return currentSigmaUSD / floor; // e.g., 2.5x normal vol
}

// Initialize immediately
loadHistory();

export const VolatilityManager = {
  updatePriceHistory,
  getRealizedVolatility,
  getVolRegimeRatio
};
