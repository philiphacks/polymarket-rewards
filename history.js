// vol_1m_multi.js
// Computes 1-minute std dev (USD) over last N hours for BTC, ETH, SOL, XRP using Pyth Benchmarks.
import fs from "fs";
import cron from "node-cron";

// ---------- CONFIG ----------
const BENCHMARKS_BASE = "https://benchmarks.pyth.network/v1/shims/tradingview";

// Asset list: key = your label, tvSymbol = Pyth TradingView symbol string
const ASSETS = [
  { key: "BTC", tvSymbol: "Crypto.BTC/USD" },
  { key: "ETH", tvSymbol: "Crypto.ETH/USD" },
  { key: "SOL", tvSymbol: "Crypto.SOL/USD" },
  { key: "XRP", tvSymbol: "Crypto.XRP/USD" },
];

const HOURS_BACK = 2;   // lookback window
const RESOLUTION = "1"; // 1-minute bars

// Output file (same as before)
const OUT_FILE = "btc_sigma_1m.json";

// ---------- MATH: std dev of 1m price changes ----------
function stdDev(arr) {
  if (arr.length === 0) return 0;
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const variance =
    arr.reduce((acc, x) => acc + (x - mean) ** 2, 0) / arr.length;
  return Math.sqrt(variance);
}

// ---------- FETCH 1-MIN BARS FOR A GIVEN SYMBOL ----------
async function fetchOneMinuteCloses(tvSymbol) {
  const nowSec = Math.floor(Date.now() / 1000);
  const fromSec = nowSec - HOURS_BACK * 60 * 60;

  const params = new URLSearchParams({
    symbol: tvSymbol,
    resolution: RESOLUTION,
    from: String(fromSec),
    to: String(nowSec),
  });

  const url = `${BENCHMARKS_BASE}/history?${params.toString()}`;
  console.log(`History URL for ${tvSymbol}:`, url);

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `History request failed for ${tvSymbol}: ${res.status} ${res.statusText}`
    );
  }
  const data = await res.json();

  // Expect TradingView-style payload: { s: "ok", c: [closes...], ... }
  if (data.s !== "ok") {
    throw new Error(`History response not ok for ${tvSymbol}: ${data.s}`);
  }
  if (!Array.isArray(data.c) || data.c.length < 2) {
    throw new Error(
      `Not enough close prices in history response for ${tvSymbol}`
    );
  }

  const closes = data.c.map((x) => Number(x));
  return closes;
}

// ---------- PER-ASSET COMPUTE ----------
async function computeSigmaForAsset(asset) {
  const { key, tvSymbol } = asset;
  const closes = await fetchOneMinuteCloses(tvSymbol);

  const deltas = [];
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (Number.isFinite(d)) deltas.push(d);
  }

  if (deltas.length === 0) {
    throw new Error(`No valid deltas for ${tvSymbol}, cannot compute std dev.`);
  }

  const sigmaPerMinUSD = stdDev(deltas);

  console.log(
    `${key}: bars=${closes.length}, deltas=${deltas.length}, ` +
      `σ₁min≈${sigmaPerMinUSD.toFixed(4)} USD`
  );

  return {
    key,
    tvSymbol,
    sigmaPerMinUSD,
    bars: closes.length,
  };
}

// ---------- MAIN ----------
const exec = async () => {
  try {
    const results = {};

    // Compute sequentially (simple, friendlier to API)
    for (const asset of ASSETS) {
      try {
        const res = await computeSigmaForAsset(asset);
        results[asset.key] = {
          symbol: res.tvSymbol,
          sigmaPerMinUSD: res.sigmaPerMinUSD,
          bars: res.bars,
        };
      } catch (err) {
        console.error(`Error computing vol for ${asset.key}:`, err.message);
      }
    }

    if (!results.BTC) {
      console.error("BTC result missing, refusing to write file.");
      return;
    }

    const out = {
      // Keep top-level fields for BTC to remain backward compatible
      symbol: results.BTC.symbol,
      hoursBack: HOURS_BACK,
      sigmaPerMinUSD: results.BTC.sigmaPerMinUSD,
      bars: results.BTC.bars,
      updatedAt: new Date().toISOString(),
      assets: results,
    };

    fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2));
    console.log(`Saved vol info for ${Object.keys(results).join(", ")} to ${OUT_FILE}`);
  } catch (err) {
    console.error("Error computing 1-min std devs:", err);
  }
};

exec();
cron.schedule("0 */15 * * * *", () => {
  exec();
});
