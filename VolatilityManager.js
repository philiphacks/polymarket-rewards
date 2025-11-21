import fs from "fs";

const HISTORY_FILE = "vol_history.json";
const WINDOW_SIZE = 60; 
const MIN_DATA_POINTS = 10; 

const FALLBACK_SIGMA_USD = {
  BTC: 70,
  ETH: 4.0,
  SOL: 0.20,
  XRP: 0.0035,
};

// Map your symbols to Binance pairs
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

function getRealizedVolatility(symbol, currentPrice) {
  const data = history[symbol];
  if (!data || data.length < MIN_DATA_POINTS) {
    return FALLBACK_SIGMA_USD[symbol];
  }

  const returns = [];
  for (let i = 1; i < data.length; i++) {
    const r = Math.log(data[i].price / data[i-1].price);
    returns.push(r);
  }

  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / (returns.length - 1);
  const stdDevReturns = Math.sqrt(variance);
  
  return Math.max(currentPrice * stdDevReturns, FALLBACK_SIGMA_USD[symbol]);
}

function getVolRegimeRatio(symbol, currentSigmaUSD) {
  const floor = FALLBACK_SIGMA_USD[symbol];
  if (!floor) return 1;
  return currentSigmaUSD / floor;
}

// --- NEW: BACKFILL FUNCTION ---
async function backfillHistory(symbols) {
  console.log("[VOL] Starting history backfill from Binance...");
  
  const promises = symbols.map(async (symbol) => {
    // 1. Check if we already have fresh data (less than 2 mins old)
    if (history[symbol] && history[symbol].length > 50) {
      const lastTs = history[symbol][history[symbol].length - 1].ts;
      if (Date.now() - lastTs < 120 * 1000) {
        console.log(`[VOL] ${symbol} history is fresh. Skipping backfill.`);
        return;
      }
    }

    // 2. Fetch from Binance
    const pair = BINANCE_PAIRS[symbol];
    if (!pair) return;

    try {
      // Fetch last 60 1m candles
      const url = `https://api.binance.com/api/v3/klines?symbol=${pair}&interval=1m&limit=${WINDOW_SIZE}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(res.statusText);
      
      const klines = await res.json();
      
      // 3. Parse (Binance format: [openTime, open, high, low, close, ...])
      // We use Close Price (index 4) and Close Time (index 6)
      const cleanData = klines.map(k => ({
        ts: k[6],         // Close time (ms)
        price: parseFloat(k[4]) // Close price
      }));

      // 4. Overwrite history
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

// Initialize
loadHistory();

export const VolatilityManager = {
  updatePriceHistory,
  getRealizedVolatility,
  getVolRegimeRatio,
  backfillHistory // Exported
};
