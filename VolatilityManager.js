import fs from "fs";

const HISTORY_FILE = "vol_history.json";
const WINDOW_SIZE = 60; 
const MIN_DATA_POINTS = 10; 

// 1 Basis Point (bps) = 0.01% = 0.0001
// These are the "Minimum Volatility" floors in Basis Points per Minute.
// If realized vol drops below this, we assume this floor to prevent noise trading.
const MIN_VOL_BPS = {
  BTC: 3.0,  // Lowered to capture more BTC volume (your best asset)
  ETH: 5.0,  // Keep steady
  SOL: 8.0,  // Raised to reduce noise/churn (your worst asset)
  XRP: 6.0,  // Keep steady
};

// Map your symbols to Binance pairs for backfill
const BINANCE_PAIRS = {
  BTC: "BTCUSDT",
  ETH: "ETHUSDT",
  SOL: "SOLUSDT",
  XRP: "XRPUSDT"
};

let history = {}; 

function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      history = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
    }
  } catch (e) {
    console.error("[VOL] Failed to load history, starting fresh.", e);
  }
}

function saveHistory() {
  try {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history));
  } catch (e) {
    console.error("[VOL] Failed to save history.", e);
  }
}

function updatePriceHistory(symbol, price) {
  if (!history[symbol]) history[symbol] = [];
  const now = Date.now();
  const lastEntry = history[symbol][history[symbol].length - 1];

  // Only add if ~1 minute has passed (58s buffer)
  if (lastEntry && now - lastEntry.ts < 58 * 1000) {
    return; 
  }

  history[symbol].push({ ts: now, price });
  if (history[symbol].length > WINDOW_SIZE) {
    history[symbol] = history[symbol].slice(-WINDOW_SIZE);
  }
  saveHistory();
}

/**
 * NEW: Get price history for drift estimation
 * Returns array of price points within the specified window
 * @param {string} symbol - Asset symbol (BTC, ETH, etc.)
 * @param {number} windowMinutes - How many minutes of history to return
 * @returns {Array<{price: number, timestamp: number}>} Price history
 */
function getPriceHistory(symbol, windowMinutes = 60) {
  const data = history[symbol];
  
  if (!data || data.length === 0) {
    return [];
  }

  const now = Date.now();
  const cutoffTime = now - (windowMinutes * 60 * 1000);
  
  // Filter to only include data within the window
  const filtered = data.filter(entry => entry.ts >= cutoffTime);
  
  // Return in format expected by drift calculation
  return filtered.map(entry => ({
    price: entry.price,
    timestamp: entry.ts
  }));
}

/**
 * Calculates Realized Volatility (Standard Deviation of Log Returns).
 * Enforces a dynamic floor based on Basis Points (BPS).
 */
function getRealizedVolatility(symbol, currentPrice) {
  const data = history[symbol];
  
  // Calculate the Dynamic Floor in USD
  const bps = MIN_VOL_BPS[symbol] || 5.0; // Default 5bps if symbol unknown
  const dynamicFloorUSD = currentPrice * (bps / 10000);

  if (!data || data.length < MIN_DATA_POINTS) {
    return dynamicFloorUSD;
  }

  const returns = [];
  for (let i = 1; i < data.length; i++) {
    // Log Return: ln(P_t / P_t-1)
    const r = Math.log(data[i].price / data[i-1].price);
    returns.push(r);
  }

  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / (returns.length - 1);
  const stdDevReturns = Math.sqrt(variance); // This is % volatility
  
  const calculatedSigmaUSD = currentPrice * stdDevReturns;

  // Return the higher of Realized Vol or the BPS Floor
  return Math.max(calculatedSigmaUSD, dynamicFloorUSD);
}

function getVolRegimeRatio(symbol, currentSigmaUSD) {
  // We need to reconstruct the floor to calculate the ratio
  // Ratio = CurrentSigma / Floor
  // If Ratio is 1.0, we are at the floor (Low Vol)
  // If Ratio is 3.0, we are 3x above the floor (High Vol)
  
  const data = history[symbol];
  const lastPrice = data && data.length > 0 ? data[data.length - 1].price : 0;
  
  if (lastPrice === 0) return 1.0;

  const bps = MIN_VOL_BPS[symbol] || 5.0;
  const dynamicFloorUSD = lastPrice * (bps / 10000);
  
  if (dynamicFloorUSD === 0) return 1.0;

  return currentSigmaUSD / dynamicFloorUSD;
}

async function backfillHistory(symbols) {
  console.log("[VOL] Starting history backfill from Binance...");
  
  const promises = symbols.map(async (symbol) => {
    if (history[symbol] && history[symbol].length > 50) {
      const lastTs = history[symbol][history[symbol].length - 1].ts;
      if (Date.now() - lastTs < 120 * 1000) {
        console.log(`[VOL] ${symbol} history is fresh. Skipping backfill.`);
        return;
      }
    }

    const pair = BINANCE_PAIRS[symbol];
    if (!pair) return;

    try {
      const url = `https://api.binance.com/api/v3/klines?symbol=${pair}&interval=1m&limit=${WINDOW_SIZE}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(res.statusText);
      
      const klines = await res.json();
      const cleanData = klines.map(k => ({
        ts: k[6],
        price: parseFloat(k[4])
      }));

      history[symbol] = cleanData;
      console.log(`[VOL] Backfilled ${symbol}: ${cleanData.length} candles.`);
      
    } catch (err) {
      console.error(`[VOL] Failed to backfill ${symbol}:`, err.message);
    }
  });

  await Promise.all(promises);
  saveHistory();
  console.log("[VOL] Backfill complete.");
}

loadHistory();

export const VolatilityManager = {
  updatePriceHistory,
  getRealizedVolatility,
  getVolRegimeRatio,
  backfillHistory,
  getPriceHistory  // NEW: Added for drift estimation
};
