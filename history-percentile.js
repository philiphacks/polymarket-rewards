// vol_1m_multi_windows.js
// For BTC, ETH, SOL, XRP: compute 1-min std dev (USD) over rolling windows
// from 7 days ago until now, then print sorted arrays + median per asset.

// Assumes Node 18+ (global fetch). If not, you'll need: import fetch from "node-fetch";

// ---------- CONFIG ----------
const BENCHMARKS_BASE = "https://benchmarks.pyth.network/v1/shims/tradingview";

// Asset list: key = label, tvSymbol = Pyth TradingView symbol string
const ASSETS = [
  { key: "BTC", tvSymbol: "Crypto.BTC/USD" },
  { key: "ETH", tvSymbol: "Crypto.ETH/USD" },
  { key: "SOL", tvSymbol: "Crypto.SOL/USD" },
  { key: "XRP", tvSymbol: "Crypto.XRP/USD" },
];

// Windowing config
const DAYS_BACK     = 7;      // look back 7 full days
const WINDOW_HOURS  = 2;      // each window is 2 hours long
const RESOLUTION    = "1";    // 1-minute bars (TradingView "1")

// ---------- MATH HELPERS ----------
function stdDev(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return 0;
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const variance =
    arr.reduce((acc, x) => acc + (x - mean) ** 2, 0) / arr.length;
  return Math.sqrt(variance);
}

function median(sortedArr) {
  const n = sortedArr.length;
  if (n === 0) return 0;
  const mid = Math.floor(n / 2);
  if (n % 2 === 1) {
    return sortedArr[mid];
  } else {
    return (sortedArr[mid - 1] + sortedArr[mid]) / 2;
  }
}

// ---------- WINDOW BUILDER ----------
function buildWindows(nowSec, daysBack, windowHours) {
  const SECS_PER_HOUR = 3600;
  const windowSecs = windowHours * SECS_PER_HOUR;
  const startSec = nowSec - daysBack * 24 * SECS_PER_HOUR;

  const windows = [];
  let from = startSec;

  // Build consecutive [from, to] windows that end no later than nowSec
  while (from + windowSecs <= nowSec) {
    const to = from + windowSecs;
    windows.push({ from, to });
    from = to;
  }

  return windows;
}

// ---------- FETCH 1-MIN BARS FOR A GIVEN SYMBOL & WINDOW ----------
async function fetchOneMinuteCloses(tvSymbol, fromSec, toSec) {
  const params = new URLSearchParams({
    symbol: tvSymbol,
    resolution: RESOLUTION,
    from: String(fromSec),
    to: String(toSec),
  });

  const url = `${BENCHMARKS_BASE}/history?${params.toString()}`;
  console.log(`History URL for ${tvSymbol} [${fromSec} → ${toSec}]:`, url);

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `History request failed for ${tvSymbol}: ${res.status} ${res.statusText}`
    );
  }

  const data = await res.json();

  // TradingView-style payload expected:
  // { s: "ok", c: [closes...], t: [timestamps...], ... }
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

// ---------- PER-ASSET: COMPUTE SIGMA PER WINDOW ----------
async function computeSigmasForAsset(asset, windows) {
  const { key, tvSymbol } = asset;
  const sigmas = [];

  console.log(`\n=== Computing sigmas for ${key} (${tvSymbol}) ===`);
  console.log(`Total windows: ${windows.length}, windowSize=${WINDOW_HOURS}h`);

  // Do it sequentially per asset to be nicer to the API
  for (let i = 0; i < windows.length; i++) {
    const { from, to } = windows[i];
    try {
      const closes = await fetchOneMinuteCloses(tvSymbol, from, to);

      // 1-minute price changes ΔS = S_t − S_{t−1}
      const deltas = [];
      for (let j = 1; j < closes.length; j++) {
        const d = closes[j] - closes[j - 1];
        if (Number.isFinite(d)) deltas.push(d);
      }

      if (deltas.length === 0) {
        console.warn(
          `${key}: window ${i + 1}/${windows.length} has no valid deltas, skipping`
        );
        continue;
      }

      const sigmaPerMinUSD = stdDev(deltas);
      sigmas.push(sigmaPerMinUSD);

      console.log(
        `${key}: window ${i + 1}/${windows.length}, bars=${closes.length}, ` +
          `deltas=${deltas.length}, σ₁min≈${sigmaPerMinUSD.toFixed(4)} USD`
      );
    } catch (err) {
      console.error(
        `${key}: error on window ${i + 1}/${windows.length} [${from} → ${to}]:`,
        err.message
      );
      // skip this window and continue
    }
  }

  return sigmas;
}

// ---------- MAIN ----------
async function exec() {
  try {
    const nowSec = Math.floor(Date.now() / 1000);
    const windows = buildWindows(nowSec, DAYS_BACK, WINDOW_HOURS);

    console.log(
      `\nBuilt ${windows.length} windows of ${WINDOW_HOURS}h over the last ${DAYS_BACK} days`
    );

    for (const asset of ASSETS) {
      const sigmas = await computeSigmasForAsset(asset, windows);

      if (!sigmas.length) {
        console.error(
          `\n${asset.key}: no valid σ samples collected over the period.`
        );
        continue;
      }

      // Sort ascending to make median / percentiles easy
      sigmas.sort((a, b) => a - b);

      const med = median(sigmas);
      const min = sigmas[0];
      const max = sigmas[sigmas.length - 1];

      console.log(
        `\n==== ${asset.key} SUMMARY ====\n` +
          `samples: ${sigmas.length}\n` +
          `min σ₁min:  ${min.toFixed(4)} USD\n` +
          `median σ₁min: ${med.toFixed(4)} USD\n` +
          `max σ₁min:  ${max.toFixed(4)} USD\n`
      );

      // If you want to eyeball the distribution:
      console.log(
        `${asset.key} σ samples (sorted):\n` +
          sigmas.map((x) => x.toFixed(4)).join(", ")
      );
    }
  } catch (err) {
    console.error("Fatal error computing 1-min std devs over windows:", err);
  }
}

exec();
