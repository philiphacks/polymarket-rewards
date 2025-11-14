// btc_15m_backtest_7d.js
// Backtests your BTC 15m Up/Down model over the last 7 days,
// at "decision time" = 3 minutes before each 15m window end.
// Requires: Node with global fetch, btc_sigma_1m.json in cwd.

// If you want env vars: uncomment this
// import 'dotenv/config';

import fs from "fs";

// ---------- CONFIG ----------
const SYMBOL = "BTC";
const VARIANT = "fifteen";
const DECISION_MINUTES_LEFT = 3;          // when you "would" evaluate inside the window
const BACKTEST_DAYS = 7;
const SIGMA_FILE = "btc_sigma_1m.json";   // from your vol script
const LOG_FILE = "btc_15m_backtest.csv";

// Pyth Benchmarks TradingView history endpoint (you already used this pattern successfully)
const PYTH_HISTORY_BASE =
  "https://benchmarks.pyth.network/v1/shims/tradingview/history";

// ---------- HELPERS: TIME / URLS ----------
const MS_15M = 15 * 60 * 1000;
const SEC = 1000;

function current15mStartUnix(date = new Date()) {
  const ms = date.getTime();
  const intervalMs = MS_15M;
  return Math.floor(ms / intervalMs) * (intervalMs / 1000);
}

function btc15mSlug(date = new Date()) {
  return `btc-updown-15m-${current15mStartUnix(date)}`;
}

// Start of the 15-minute interval in UTC
function current15mStartUTC(date = new Date()) {
  const d = new Date(date);
  d.setUTCMinutes(Math.floor(d.getUTCMinutes() / 15) * 15, 0, 0);
  return d;
}

// End of the 15-minute interval in UTC
function current15mEndUTC(date = new Date()) {
  const start = current15mStartUTC(date);
  return new Date(start.getTime() + MS_15M);
}

// ISO without ms, e.g. "2025-11-14T00:15:00Z"
function isoNoMs(d) {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function cryptoPriceUrl({ symbol, date, variant }) {
  const start = current15mStartUTC(date);
  const end = current15mEndUTC(date);

  const base = "https://polymarket.com/api/crypto/crypto-price";
  const params = new URLSearchParams({
    symbol,
    eventStartTime: isoNoMs(start),
    variant,
    endDate: isoNoMs(end),
  });
  return `${base}?${params.toString()}`;
}

// ---------- HELPERS: MATH / CSV ----------
function normCdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp(-0.5 * z * z);
  let p =
    d *
    t *
    (0.3193815 +
      t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  if (z > 0) p = 1 - p;
  return p;
}

function ensureCsvHeader(path) {
  if (!fs.existsSync(path)) {
    fs.writeFileSync(
      path,
      [
        "timestamp_run",
        "slug",
        "interval_start_iso",
        "interval_end_iso",
        "decision_time_iso",
        "start_price",
        "decision_price",
        "final_price",
        "minutes_left_at_decision",
        "sigma_per_min",
        "z_at_decision",
        "p_up_model",
        "realized_up", // 1 if final_price >= start_price else 0
      ].join(",") + "\n",
      "utf8"
    );
  }
}

// ---------- PYTH HISTORY HELPERS ----------

// Build Pyth Benchmarks TradingView history URL for 1m bars
function pythHistoryUrl(fromSec, toSec) {
  const params = new URLSearchParams({
    symbol: "Crypto.BTC/USD",
    resolution: "1",
    from: String(fromSec),
    to: String(toSec),
  });
  return `${PYTH_HISTORY_BASE}?${params.toString()}`;
}

// Get Pyth close price around a specific Unix timestamp (sec)
// Strategy: request last minute window [ts-60, ts], use last close.
async function getPythPriceAt(tsSec) {
  const from = tsSec - 60; // 1 minute before
  const to = tsSec;

  const url = pythHistoryUrl(from, to);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Pyth history request failed: ${res.status} ${res.statusText}`);
  }
  const data = await res.json();

  // We rely on the same schema you already used successfully:
  // { t: [...timestamps], c: [...closes], ... }
  if (!data || !Array.isArray(data.c) || data.c.length === 0) {
    throw new Error("No close data returned from Pyth history");
  }

  const closes = data.c;
  const lastClose = Number(closes[closes.length - 1]);
  if (!Number.isFinite(lastClose)) {
    throw new Error("Invalid close value from Pyth history");
  }
  return lastClose;
}

// ---------- MAIN BACKTEST LOGIC ----------

async function backtestInterval(windowStartMs) {
  const windowStart = new Date(windowStartMs);
  const windowEnd = new Date(windowStartMs + MS_15M);

  const slug = btc15mSlug(windowStart);
  const gammaUrl = `https://gamma-api.polymarket.com/markets/slug/${slug}`;
  const cpUrl = cryptoPriceUrl({
    symbol: SYMBOL,
    date: windowStart,
    variant: VARIANT,
  });

  const intervalStartIso = isoNoMs(windowStart);
  const intervalEndIso = isoNoMs(windowEnd);

  // Decision time: end - DECISION_MINUTES_LEFT
  const decisionTimeMs =
    windowEnd.getTime() - DECISION_MINUTES_LEFT * 60 * 1000;
  const decisionTime = new Date(decisionTimeMs);
  const decisionTimeIso = isoNoMs(decisionTime);

  // 1) Check if market exists (Gamma)
  const gammaRes = await fetch(gammaUrl);
  if (gammaRes.status === 404) {
    console.log(`No market for slug ${slug} (404)`);
    return null;
  }
  if (!gammaRes.ok) {
    console.log(
      `Gamma error for slug ${slug}: ${gammaRes.status} ${gammaRes.statusText}`
    );
    return null;
  }
  const market = await gammaRes.json();

  // Optional sanity: skip markets that aren't BTC 15m up/down if something weird
  if (!market.question || !market.question.includes("Bitcoin Up or Down")) {
    console.log(`Skipping non-BTC-UpDown market for slug ${slug}`);
    return null;
  }

  // 2) Start price from Polymarket crypto-price (openPrice)
  const cpRes = await fetch(cpUrl);
  if (!cpRes.ok) {
    console.log(
      `crypto-price error for slug ${slug}: ${cpRes.status} ${cpRes.statusText}`
    );
    return null;
  }
  const cp = await cpRes.json();
  const startPrice = Number(cp.openPrice);
  if (!Number.isFinite(startPrice)) {
    console.log(`openPrice missing/invalid for slug ${slug}`);
    return null;
  }

  // 3) Pyth prices:
  // - at decision time (for the model)
  // - at end time (for realized outcome)
  const decisionTsSec = Math.floor(decisionTime.getTime() / SEC);
  const endTsSec = Math.floor(windowEnd.getTime() / SEC);

  const decisionPrice = await getPythPriceAt(decisionTsSec);
  const finalPrice = await getPythPriceAt(endTsSec);

  // 4) Load sigma per minute from file (same as your live script)
  const sigmaCfg = JSON.parse(fs.readFileSync(SIGMA_FILE, "utf8"));
  const sigmaPerMin = Number(sigmaCfg.sigmaPerMinUSD);
  if (!Number.isFinite(sigmaPerMin)) {
    throw new Error("Invalid sigmaPerMinUSD in btc_sigma_1m.json");
  }

  // Horizon for model at decision time:
  const minsLeft =
    (windowEnd.getTime() - decisionTime.getTime()) / (60 * 1000);

  // 5) Compute model P(Up) at decision time
  const sigmaT = sigmaPerMin * Math.sqrt(minsLeft);
  const diff = decisionPrice - startPrice;
  const z = diff / sigmaT;
  const pUp = normCdf(z);

  // 6) Realized outcome using Pyth final price vs startPrice
  const realizedUp = finalPrice >= startPrice ? 1 : 0;

  // 7) Log one CSV row
  const row = [
    new Date().toISOString(),      // timestamp_run
    slug,                          // slug
    intervalStartIso,              // interval_start_iso
    intervalEndIso,                // interval_end_iso
    decisionTimeIso,               // decision_time_iso
    startPrice,                    // start_price
    decisionPrice,                 // decision_price
    finalPrice,                    // final_price
    minsLeft.toFixed(3),           // minutes_left_at_decision
    sigmaPerMin.toFixed(6),        // sigma_per_min
    z.toFixed(6),                  // z_at_decision
    pUp.toFixed(6),                // p_up_model
    realizedUp                     // realized_up (0/1)
  ].join(",");

  fs.appendFileSync(LOG_FILE, row + "\n", "utf8");

  console.log(
    `Logged ${slug}: P(Up)=${pUp.toFixed(3)}, realizedUp=${realizedUp}, z=${z.toFixed(
      3
    )}`
  );

  return {
    slug,
    pUp,
    realizedUp,
  };
}

(async () => {
  try {
    ensureCsvHeader(LOG_FILE);

    const now = Date.now();
    const startMs = now - BACKTEST_DAYS * 24 * 60 * 60 * 1000;

    // Align start to 15m boundary
    let tMs = Math.floor(startMs / MS_15M) * MS_15M;

    while (tMs + MS_15M <= now) {
      try {
        await backtestInterval(tMs);
      } catch (err) {
        console.error(
          `Error backtesting interval starting ${new Date(tMs).toISOString()}:`,
          err.message
        );
      }
      tMs += MS_15M;
    }

    console.log("Backtest finished. Results in", LOG_FILE);
  } catch (err) {
    console.error("Fatal error in backtest script:", err);
  }
})();
