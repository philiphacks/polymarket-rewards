// multi_crypto_updown_bot.mjs
import 'dotenv/config';
import cron from "node-cron";
import clob from "@polymarket/clob-client";
const { ClobClient, Side, OrderType } = clob;
import { Wallet } from "@ethersproject/wallet";
import fs from "fs";

// ---------- GLOBAL CONFIG ----------
let interval = 5; // seconds between runs

// Per-asset config (Polymarket + Pyth)
const ASSETS = [
  {
    symbol: "BTC",
    slugPrefix: "btc",
    pythId: "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
    volKey: "BTC/USD",
  },
  {
    symbol: "ETH",
    slugPrefix: "eth",
    pythId: "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
    volKey: "ETH/USD",
  },
  {
    symbol: "SOL",
    slugPrefix: "sol",
    pythId: "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
    volKey: "SOL/USD",
  },
  {
    symbol: "XRP",
    slugPrefix: "xrp",
    pythId: "0xec5d399846a9209f3fe5881d70aae9268c94339ff9817e8d18ff19fa05eea1c8",
    volKey: "XRP/USD",
  },
];

// Max shares per 15m market *per asset*
const MAX_SHARES_PER_MARKET = 500;

// Time / z thresholds & sanity checks
const MIN_EDGE = 0.03;     // 3% EV threshold
const MINUTES_LEFT = 5;    // only act in last X minutes (unless |z| big)
const Z_MIN = 0.5;         // min |z| to even consider directional trade
const Z_MAX = 1.5;         // if |z| >= this, ignore MINUTES_LEFT condition
const MAX_REL_DIFF = 0.05; // 5% sanity check between start & current price

// CLOB / signing
const CLOB_HOST = "https://clob.polymarket.com";
const CHAIN_ID = 137;
const SIGNATURE_TYPE = 1;
const FUNDER = "0xA69b1867a00c87928b5A1f6B1c2e9aC2246bD844";

const signer = new Wallet(process.env.PRIVATE_KEY);
const credsP = new ClobClient(CLOB_HOST, CHAIN_ID, signer).createOrDeriveApiKey();
const creds = await credsP;
console.log("Address:", await signer.getAddress());
const client = new ClobClient(CLOB_HOST, CHAIN_ID, signer, creds, SIGNATURE_TYPE, FUNDER);

// Vol config (multi-asset) from btc_sigma_1m.json
// EXPECTED SHAPE:
// {
//   "assets": {
//     "BTC/USD": { "sigmaPerMinUSD": 63.1, ... },
//     "ETH/USD": { "sigmaPerMinUSD": ... },
//     "SOL/USD": { "sigmaPerMinUSD": ... },
//     "XRP/USD": { "sigmaPerMinUSD": ... }
//   },
//   "updatedAt": "..."
//   ...
// }
const sigmaConfig = JSON.parse(fs.readFileSync("btc_sigma_1m.json", "utf8"));
console.log("Loaded sigma file keys:", Object.keys(sigmaConfig));

// ---------- UTILS ----------

// Returns unix timestamp (seconds) of the start of the current 15-min interval
function current15mStartUnix(date = new Date()) {
  const ms = date.getTime();
  const intervalMs = 15 * 60 * 1000;
  return Math.floor(ms / intervalMs) * (intervalMs / 1000);
}

// Generic slug for 15m up/down markets
function crypto15mSlug(slugPrefix, date = new Date()) {
  return `${slugPrefix}-updown-15m-${current15mStartUnix(date)}`;
}

// Start of the current 15-minute interval (UTC)
function current15mStartUTC(date = new Date()) {
  const d = new Date(date);
  d.setUTCMinutes(Math.floor(d.getUTCMinutes() / 15) * 15, 0, 0);
  return d;
}

// End of the current 15-minute interval (UTC)
function current15mEndUTC(date = new Date()) {
  const start = current15mStartUTC(date);
  return new Date(start.getTime() + 15 * 60 * 1000);
}

// ISO without milliseconds
function isoNoMs(d) {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

// Polymarket crypto-price URL for a symbol
function cryptoPriceUrl({ symbol, date = new Date(), variant = "fifteen" }) {
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

// Normal CDF (approx)
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

// Best bid/ask from order book
function getBestBidAsk(ob) {
  let bestBid = null;
  let bestAsk = null;

  if (Array.isArray(ob.bids) && ob.bids.length > 0) {
    bestBid = ob.bids.reduce(
      (max, o) => Math.max(max, Number(o.price)),
      -Infinity
    );
  }

  if (Array.isArray(ob.asks) && ob.asks.length > 0) {
    bestAsk = ob.asks.reduce(
      (min, o) => Math.min(min, Number(o.price)),
      Infinity
    );
  }

  return {
    bestBid: Number.isFinite(bestBid) ? bestBid : null,
    bestAsk: Number.isFinite(bestAsk) ? bestAsk : null,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Get per-asset sigma
function getSigmaPerMinUSD(volKey) {
  const assets = sigmaConfig.assets || {};
  const entry = assets[volKey];
  if (entry && typeof entry.sigmaPerMinUSD === "number") {
    return entry.sigmaPerMinUSD;
  }
  // Fallback to global sigmaPerMinUSD if present, else hardcoded default
  if (typeof sigmaConfig.sigmaPerMinUSD === "number") {
    return sigmaConfig.sigmaPerMinUSD;
  }

  // default fallback
  if (volKey === "BTC") {
    return 105.3;
  } else if (volKey === "SOL") {
    return 0.2;
  } else if (volKey === "ETH") {
    return 4;
  } else if (volKey === "XRP") {
    return 0.003;
  }
}

// ---------- PER-ASSET STATE ----------
const stateBySymbol = {};

// Initialize/Reset state for an asset (new 15m window)
function resetStateForAsset(asset) {
  const slug = crypto15mSlug(asset.slugPrefix);
  const cryptoUrl = cryptoPriceUrl({ symbol: asset.symbol });
  const gammaUrl = `https://gamma-api.polymarket.com/markets/slug/${slug}`;

  stateBySymbol[asset.symbol] = {
    slug,
    cryptoPriceUrl: cryptoUrl,
    gammaUrl,
    sharesBoughtBySlug: { [slug]: 0 }, // track per-market
    resetting: false,
  };

  console.log(
    `[${asset.symbol}] Reset: slug=${slug}, cryptoPriceUrl=${cryptoUrl}, gammaUrl=${gammaUrl}`
  );
}

// Ensure state exists
function ensureState(asset) {
  if (!stateBySymbol[asset.symbol]) {
    resetStateForAsset(asset);
  }
  return stateBySymbol[asset.symbol];
}

// ---------- CORE EXECUTION PER ASSET ----------
async function execForAsset(asset) {
  const state = ensureState(asset);
  if (state.resetting) return;

  const { slug, cryptoPriceUrl, gammaUrl } = state;

  console.log(`\n\n===== ${asset.symbol} | slug=${slug} =====`);

  // 1) Fetch market from Gamma
  const gammaRes = await fetch(gammaUrl);
  if (!gammaRes.ok) {
    console.log(
      `[${asset.symbol}] Gamma request failed: ${gammaRes.status} ${gammaRes.statusText}`
    );
    return;
  }
  const market = await gammaRes.json();

  const endMs = new Date(market.endDate).getTime();
  const nowMs = Date.now();
  const minsLeft = Math.max((endMs - nowMs) / 60000, 0.001);

  console.log(`[${asset.symbol}] Question:`, market.question);
  console.log(`[${asset.symbol}] End date:`, market.endDate);
  console.log(`[${asset.symbol}] Minutes left:`, minsLeft.toFixed(3));

  // If market basically over, wait a bit and reset to next 15m market
  if (minsLeft < 0.01) {
    state.resetting = true;
    console.log(`[${asset.symbol}] Interval over. Resetting in 30s...`);
    await sleep(30_000);
    resetStateForAsset(asset);
    return;
  }

  // 2) Fetch start price (openPrice) from Polymarket crypto-price API
  const cpRes = await fetch(cryptoPriceUrl);
  if (!cpRes.ok) {
    console.log(
      `[${asset.symbol}] crypto-price failed: ${cpRes.status} ${cpRes.statusText}`
    );
    return;
  }
  const cp = await cpRes.json();
  const startPrice = Number(cp.openPrice);
  if (!Number.isFinite(startPrice)) {
    console.log(`[${asset.symbol}] openPrice missing or non-numeric`);
    return;
  }
  console.log(`[${asset.symbol}] Start price (openPrice):`, startPrice);

  // 3) Fetch current price from Pyth Hermes (per-asset feed ID)
  const pythUrl =
    "https://hermes.pyth.network/api/latest_price_feeds?ids[]=" + asset.pythId;

  const pythRes = await fetch(pythUrl);
  if (!pythRes.ok) {
    console.log(
      `[${asset.symbol}] Pyth request failed: ${pythRes.status} ${pythRes.statusText}`
    );
    return;
  }
  const pythArr = await pythRes.json();
  const pyth0 = pythArr[0];
  const pythPriceObj = pyth0.price;

  const raw = Number(pythPriceObj.price);
  const expo = Number(pythPriceObj.expo);
  if (!Number.isFinite(raw) || !Number.isFinite(expo)) {
    console.log(`[${asset.symbol}] Pyth price/expo missing`);
    return;
  }
  const currentPrice = raw * Math.pow(10, expo);
  console.log(`[${asset.symbol}] Current price (Pyth):`, currentPrice);

  // Sanity check: Polymarket vs Pyth
  const relDiff = Math.abs(currentPrice - startPrice) / startPrice;
  if (relDiff > MAX_REL_DIFF) {
    console.log(
      `[${asset.symbol}] Price sanity FAILED (>${MAX_REL_DIFF * 100}%). Skipping.`,
      { startPrice, currentPrice, relDiff }
    );
    return;
  }

  // 4) Compute probability Up using per-asset σ
  const SIGMA_PER_MIN = getSigmaPerMinUSD(asset.volKey);
  const sigmaT = SIGMA_PER_MIN * Math.sqrt(minsLeft);
  const diff = currentPrice - startPrice;
  const z = diff / sigmaT;
  const pUp = normCdf(z);
  const pDown = 1 - pUp;

  console.log(`[${asset.symbol}] min z-score:`, Z_MIN.toFixed(3));
  console.log(`[${asset.symbol}] z-score:`, z.toFixed(3));
  console.log(`[${asset.symbol}] Model P(Up):`, pUp.toFixed(4));
  console.log(`[${asset.symbol}] Model P(Down):`, pDown.toFixed(4));

  // If |z| small AND still early → no trade
  if ((Math.abs(z) < Z_MAX || Math.abs(z) > 5) && minsLeft > MINUTES_LEFT) {
    console.log(
      `[${asset.symbol}] Earlier than ${MINUTES_LEFT} mins left and |z| not huge. No trade yet.`
    );
    return;
  }

  // 5) Order books
  const tokenIds = JSON.parse(market.clobTokenIds);
  const upTokenId = tokenIds[0];
  const downTokenId = tokenIds[1];

  const [upBook, downBook] = await Promise.all([
    client.getOrderBook(upTokenId),
    client.getOrderBook(downTokenId),
  ]);

  const { bestAsk: upAsk } = getBestBidAsk(upBook);
  const { bestAsk: downAsk } = getBestBidAsk(downBook);

  if (upAsk == null && downAsk == null) {
    console.log(`[${asset.symbol}] No asks on either side. No trade.`);
    return;
  }

  const mid =
    upAsk != null && downAsk != null ? (upAsk + downAsk) / 2 : upAsk ?? downAsk;
  console.log(
    `[${asset.symbol}] Up ask / Down ask: ${upAsk?.toFixed(
      3
    )} / ${downAsk?.toFixed(3)}, mid≈${mid?.toFixed(3)}`
  );

  // Directional buy-only logic (same as before)
  let candidates = [];

  if (z >= Z_MIN && upAsk != null) {
    const evBuyUp = pUp - upAsk;
    console.log(
      `[${asset.symbol}] Up ask=${upAsk.toFixed(
        3
      )}, EV buy Up (pUp - ask)= ${evBuyUp.toFixed(4)}`
    );
    candidates.push({ side: "UP", ev: evBuyUp, ask: upAsk });
  } else {
    console.log(`[${asset.symbol}] We don't buy Up here (z too small or no ask).`);
  }

  if (z <= -Z_MIN && downAsk != null) {
    const evBuyDown = pDown - downAsk;
    console.log(
      `[${asset.symbol}] Down ask=${downAsk.toFixed(
        3
      )}, EV buy Down (pDown - ask)= ${evBuyDown.toFixed(4)}`
    );
    candidates.push({ side: "DOWN", ev: evBuyDown, ask: downAsk });
  } else {
    console.log(
      `[${asset.symbol}] We don't buy Down here (|z| too small or no ask).`
    );
  }

  // Filter by EV threshold
  candidates = candidates.filter((c) => c.ev > MIN_EDGE);

  // ---------- Late-game "all-in-ish" mode ----------
  if (Math.abs(z) > Z_MAX || (minsLeft < 2 && minsLeft > 0.001)) {
    const expiresAt = Math.floor(Date.now() / 1000) + 15 * 60;

    const windowSecs = 120; // 2 minutes
    const secsLeftRaw = minsLeft * 60;
    const secsLeft = Math.max(0, Math.min(windowSecs, secsLeftRaw));
    const progress = (windowSecs - secsLeft) / windowSecs;

    const LEVELS = 5;
    let level = Math.floor(progress * LEVELS);
    level = Math.min(LEVELS - 1, Math.max(0, level));

    const zAbs = Math.min(Math.abs(z), 3);
    const zFrac = zAbs / 3;

    const basePriceLow = 0.95;
    const basePriceHigh = 0.99;
    const maxPriceLow = 0.96;
    const maxPriceHigh = 0.99;

    const basePrice =
      basePriceLow + (basePriceHigh - basePriceLow) * zFrac;
    const maxPrice =
      maxPriceLow + (maxPriceHigh - maxPriceLow) * zFrac;

    const baseSize = 25;
    const maxSize = 100;

    const priceStep = (maxPrice - basePrice) / (LEVELS - 1);
    const sizeStep = (maxSize - baseSize) / (LEVELS - 1);

    const limitPrice = Number((basePrice + priceStep * level).toFixed(2));
    const orderSize = Math.round(baseSize + sizeStep * level);

    console.log(
      `[${asset.symbol}] Late game: secsLeft=${secsLeft.toFixed(
        1
      )}, level=${level}, |z|=${zAbs.toFixed(
        3
      )}, basePrice=${basePrice.toFixed(3)}, maxPrice=${maxPrice.toFixed(
        3
      )}, limitPrice=${limitPrice}, size=${orderSize}`
    );

    const slugShares = state.sharesBoughtBySlug[slug] || 0;

    // UP side
    if ((pUp >= 0.85 || secsLeft < 7) && z > 0.15) {
      if (slugShares + orderSize <= MAX_SHARES_PER_MARKET) {
        console.log(
          `[${asset.symbol}] Late game: BUY UP (high probability / very late)`
        );
        const resp = await client.createAndPostOrder(
          {
            tokenID: upTokenId,
            price: limitPrice,
            side: Side.BUY,
            size: orderSize,
            expiration: String(expiresAt),
          },
          { tickSize: "0.01", negRisk: false },
          OrderType.GTD
        );
        console.log(`[${asset.symbol}] UP GTD:`, resp);
        state.sharesBoughtBySlug[slug] = slugShares + orderSize;
      } else {
        console.log(
          `[${asset.symbol}] Skipping UP late buy; would exceed ${MAX_SHARES_PER_MARKET} shares`
        );
      }
    }

    // DOWN side
    if ((pDown >= 0.85 || secsLeft < 7) && z < -0.15) {
      if (slugShares + orderSize <= MAX_SHARES_PER_MARKET) {
        console.log(
          `[${asset.symbol}] Late game: BUY DOWN (high probability / very late)`
        );
        const resp = await client.createAndPostOrder(
          {
            tokenID: downTokenId,
            price: limitPrice,
            side: Side.BUY,
            size: orderSize,
            expiration: String(expiresAt),
          },
          { tickSize: "0.01", negRisk: false },
          OrderType.GTD
        );
        console.log(`[${asset.symbol}] DOWN GTD:`, resp);
        state.sharesBoughtBySlug[slug] =
          (state.sharesBoughtBySlug[slug] || 0) + orderSize;
      } else {
        console.log(
          `[${asset.symbol}] Skipping DOWN late buy; would exceed ${MAX_SHARES_PER_MARKET} shares`
        );
      }
    }
  }

  // ---------- Normal EV-based entries ----------
  if (candidates.length === 0) {
    console.log(
      `[${asset.symbol}] No trade: no side with enough edge in the right direction.`
    );
    return;
  }

  const best = candidates.reduce((a, b) => (b.ev > a.ev ? b : a));
  const currentShares = state.sharesBoughtBySlug[slug] || 0;
  const size = 100;

  if (currentShares + size > MAX_SHARES_PER_MARKET) {
    console.log(
      `[${asset.symbol}] Skipping EV buy; would exceed ${MAX_SHARES_PER_MARKET} shares`
    );
    return;
  }

  console.log(
    `[${asset.symbol}] >>> SIGNAL: BUY ${best.side} @ ${best.ask.toFixed(
      3
    )}, EV=${best.ev.toFixed(4)}, size=${size}`
  );

  const expiresAt = Math.floor(Date.now() / 1000) + 15 * 60;
  const resp = await client.createAndPostOrder(
    {
      tokenID: best.side === "UP" ? upTokenId : downTokenId,
      price: best.ask.toFixed(2),
      side: Side.BUY,
      size,
      expiration: String(expiresAt),
    },
    { tickSize: "0.01", negRisk: false },
    OrderType.GTD
  );

  console.log(`[${asset.symbol}] ORDER RESP:`, resp);
  state.sharesBoughtBySlug[slug] = currentShares + size;
}

// ---------- MAIN SCHEDULER ----------
async function execAll() {
  console.log("\n\n\n======================= RUN =======================");
  for (const asset of ASSETS) {
    try {
      await execForAsset(asset);
    } catch (err) {
      console.error(`[${asset.symbol}] ERROR:`, err);
    }
  }
}

let task = cron.schedule(`*/${interval} * * * * *`, async () => {
  await execAll();
});
