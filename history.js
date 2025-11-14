// btc_vol_1m.js
// Computes BTC 1-minute std dev (USD) over last 8 hours using Pyth Benchmarks.
import fs from "fs";

// ---------- CONFIG ----------
const BENCHMARKS_BASE = "https://benchmarks.pyth.network/v1/shims/tradingview";

// NOTE: This symbol string is common in Pyth examples, but
// *you must verify* it in /symbols from the same API.
const SYMBOL = "Crypto.BTC/USD";

// 15 mins of 1-minute bars
// const HOURS_BACK = 2;
const HOURS_BACK = 0.25;
const RESOLUTION = "1"; // 1-minute bars (check this in docs)

// ---------- MATH: std dev of 1m price changes ----------
function stdDev(arr) {
  if (arr.length === 0) return 0;
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const variance =
    arr.reduce((acc, x) => acc + (x - mean) ** 2, 0) / arr.length;
  return Math.sqrt(variance);
}

// ---------- FETCH 1-MIN BARS (ASSUMED TRADINGVIEW FORMAT) ----------
async function fetchOneMinuteCloses() {
  const nowSec = Math.floor(Date.now() / 1000);
  const fromSec = nowSec - HOURS_BACK * 60 * 60;

  // ⚠️ ASSUMPTION:
  // Pyth’s TradingView shim follows the standard TradingView UDF history API:
  //   GET /history?symbol=...&resolution=...&from=...&to=...
  // You MUST confirm these parameter names in:
  //   https://benchmarks.pyth.network/redoc
  // section: "History: https://benchmarks.pyth.network/v1/shims/tradingview/history"
  const params = new URLSearchParams({
    symbol: SYMBOL,
    resolution: RESOLUTION,
    from: String(fromSec),
    to: String(nowSec),
  });

  const url = `${BENCHMARKS_BASE}/history?${params.toString()}`;
  console.log("History URL:", url);

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`History request failed: ${res.status} ${res.statusText}`);
  }
  const data = await res.json();
  // console.log(data); // inspect once to see the exact format

  // ⚠️ ASSUMPTION:
  // Standard TradingView /history returns something like:
  // {
  //   s: "ok",
  //   t: [timestamps...],
  //   c: [closePrices...],
  //   o: [...], h: [...], l: [...]
  // }
  // You MUST verify that `data.c` exists and is numeric array.
  if (data.s !== "ok") {
    throw new Error(`History response not ok: ${data.s}`);
  }
  if (!Array.isArray(data.c) || data.c.length < 2) {
    throw new Error("Not enough close prices in history response");
  }

  // Ensure they're numbers
  const closes = data.c.map((x) => Number(x));
  return closes;
}

// ---------- MAIN ----------
(async () => {
  try {
    const closes = await fetchOneMinuteCloses();

    // 1-minute price changes ΔS = S_t - S_{t-1}
    const deltas = [];
    for (let i = 1; i < closes.length; i++) {
      const d = closes[i] - closes[i - 1];
      if (Number.isFinite(d)) deltas.push(d);
    }

    if (deltas.length === 0) {
      console.log("No valid deltas, cannot compute std dev.");
      return;
    }

    const sigmaPerMinUSD = stdDev(deltas);

    console.log(`Bars fetched: ${closes.length}`);
    console.log(`Deltas used:  ${deltas.length}`);
    console.log(`BTC 1-min σ (USD) over last ${HOURS_BACK}h ≈ ${sigmaPerMinUSD.toFixed(4)} USD`);

    // write to a JSON file for other scripts
    const out = {
      symbol: "BTC/USD",
      hoursBack: HOURS_BACK,
      sigmaPerMinUSD,
      updatedAt: new Date().toISOString(),
      bars: closes.length,
    };

    fs.writeFileSync("btc_sigma_1m.json", JSON.stringify(out, null, 2));
    console.log("Saved vol info to btc_sigma_1m.json");
  } catch (err) {
    console.error("Error computing BTC 1-min std dev:", err);
  }
})();
