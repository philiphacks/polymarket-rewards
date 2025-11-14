// npm i node-fetch
import fs from "fs";
import fetch from "node-fetch";

// ---------- CONFIG ----------
const SLUG = "btc-updown-15m-1763073000"; // or whichever window you target
const GAMMA_URL = `https://gamma-api.polymarket.com/markets/slug/${SLUG}`;

const CRYPTO_PRICE_URL =
  "https://polymarket.com/api/crypto/crypto-price" +
  "?symbol=BTC" +
  "&eventStartTime=2025-11-13T22:45:00Z" +
  "&variant=fifteen" +
  "&endDate=2025-11-13T23:00:00Z";

// Pyth Hermes BTC/USD (feed id from docs; you already used this successfully)
const PYTH_HERMES_URL =
  "https://hermes.pyth.network/api/latest_price_feeds?ids[]=" +
  "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43";

// Use sigma from your vol script
const SIGMA_FILE = "btc_sigma_1m.json";

// Edge threshold for *expected value* in probability points
const MIN_EDGE = 0.03; // 3%

// CSV log file
const LOG_FILE = "btc_updown_log.csv";

// ---------- MATH HELPERS ----------
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
        "timestamp",
        "slug",
        "minutes_left",
        "start_price",
        "current_price",
        "sigma_per_min",
        "z",
        "p_up",
        "bid_up",
        "ask_up",
        "mid_up",
        "ev_buy_up",
        "ev_short_up",
      ].join(",") + "\n",
      "utf8"
    );
  }
}

// ---------- MAIN ----------
(async () => {
  // 0) Load sigma from file
  const sigmaConfig = JSON.parse(fs.readFileSync(SIGMA_FILE, "utf8"));
  const SIGMA_PER_MIN = Number(sigmaConfig.sigmaPerMinUSD);
  if (!Number.isFinite(SIGMA_PER_MIN)) {
    throw new Error("Invalid sigmaPerMinUSD in btc_sigma_1m.json");
  }

  // 1) Gamma: market metadata
  const gammaRes = await fetch(GAMMA_URL);
  if (!gammaRes.ok) {
    throw new Error(`Gamma request failed: ${gammaRes.status} ${gammaRes.statusText}`);
  }
  const market = await gammaRes.json();

  const endMs = new Date(market.endDate).getTime();
  const nowMs = Date.now();
  const minsLeft = Math.max((endMs - nowMs) / 60000, 0.001);

  console.log("Question:", market.question);
  console.log("End date:", market.endDate);
  console.log("Minutes left:", minsLeft.toFixed(3));

  // 2) Start price from crypto-price (openPrice)
  const cpRes = await fetch(CRYPTO_PRICE_URL);
  if (!cpRes.ok) {
    throw new Error(`crypto-price request failed: ${cpRes.status} ${cpRes.statusText}`);
  }
  const cp = await cpRes.json();
  const startPrice = Number(cp.openPrice);
  if (!Number.isFinite(startPrice)) {
    throw new Error("openPrice missing or non-numeric");
  }
  console.log("Start price (openPrice):", startPrice);

  // 3) Current BTC price from Pyth
  const pythRes = await fetch(PYTH_HERMES_URL);
  if (!pythRes.ok) {
    throw new Error(`Pyth request failed: ${pythRes.status} ${pythRes.statusText}`);
  }
  const pythArr = await pythRes.json();
  const p = pythArr[0].price;
  const raw = Number(p.price);
  const expo = Number(p.expo);
  if (!Number.isFinite(raw) || !Number.isFinite(expo)) {
    throw new Error("Pyth price/expo invalid");
  }
  const currentPrice = raw * Math.pow(10, expo);
  console.log("Current BTC price (Pyth):", currentPrice);

  // 4) Model probability P(Up)
  const sigmaT = SIGMA_PER_MIN * Math.sqrt(minsLeft);
  const diff = currentPrice - startPrice;
  const z = diff / sigmaT;
  const pUp = normCdf(z);

  console.log("z-score:", z.toFixed(3));
  console.log("Model P(Up):", pUp.toFixed(4));

  // 5) Market prices for Up: use Gamma bestBid / bestAsk for this market
  const bid = Number(market.bestBid);
  const ask = Number(market.bestAsk);
  if (!Number.isFinite(bid) || !Number.isFinite(ask)) {
    throw new Error("bestBid/bestAsk missing from market");
  }
  const mid = (bid + ask) / 2;

  console.log(
    `Up bid/ask: ${bid.toFixed(3)} / ${ask.toFixed(3)}, mid≈${mid.toFixed(3)}`
  );

  // 6) EV metrics
  const evBuyUp = pUp - ask; // expected value of buying Up at ask
  const evShortUp = bid - pUp; // expected value of shorting Up at bid

  console.log("EV buy Up (pUp - ask):", evBuyUp.toFixed(4));
  console.log("EV short Up (bid - pUp):", evShortUp.toFixed(4));

  // 7) Decide & log
  if (evBuyUp > MIN_EDGE) {
    console.log(">>> SIGNAL: BUY UP");
  } else if (evShortUp > MIN_EDGE) {
    console.log(">>> SIGNAL: SHORT UP / BUY DOWN");
  } else {
    console.log(">>> No trade: edge too small");
  }

  // Log to CSV for backtesting
  ensureCsvHeader(LOG_FILE);
  const line = [
    new Date().toISOString(),
    SLUG,
    minsLeft.toFixed(3),
    startPrice,
    currentPrice,
    SIGMA_PER_MIN,
    z.toFixed(6),
    pUp.toFixed(6),
    bid.toFixed(6),
    ask.toFixed(6),
    mid.toFixed(6),
    evBuyUp.toFixed(6),
    evShortUp.toFixed(6),
  ].join(",");

  fs.appendFileSync(LOG_FILE, line + "\n", "utf8");
  console.log(`Appended line to ${LOG_FILE}`);
})().catch((err) => {
  console.error("Error in script:", err);
});
