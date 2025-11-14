import 'dotenv/config';
import cron from "node-cron";
import clob from "@polymarket/clob-client";
const { ClobClient, Side, OrderType } = clob;
import { Wallet } from "@ethersproject/wallet";
import fs from "fs";

// ---------- CONFIG (EDIT THESE) ----------
let interval = 5; // seconds
const MAX_REL_DIFF = 0.05; // 5%

// Returns the unix timestamp (seconds) of the start of the current 15-min interval
function current15mStartUnix(date = new Date()) {
  const ms = date.getTime();
  const intervalMs = 15 * 60 * 1000;        // 15 minutes
  return Math.floor(ms / intervalMs) * (intervalMs / 1000);
}

function btc15mSlug(date = new Date()) {
  return `btc-updown-15m-${current15mStartUnix(date)}`;
}

// Start of the current 15-minute interval (UTC)
function current15mStartUTC(date = new Date()) {
  const d = new Date(date);
  d.setUTCMinutes(Math.floor(d.getUTCMinutes() / 15) * 15, 0, 0);
  return d; // Date object at :00, :15, :30, or :45
}

// End of the current 15-minute interval (UTC)
function current15mEndUTC(date = new Date()) {
  const start = current15mStartUTC(date);
  return new Date(start.getTime() + 15 * 60 * 1000);
}

// Helper: ISO without milliseconds (e.g., "2025-11-14T00:15:00Z")
function isoNoMs(d) {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function cryptoPriceUrl({
  symbol = 'BTC',
  date = new Date(),
  variant = 'fifteen',
} = {}) {
  const start = current15mStartUTC(date);
  const end   = current15mEndUTC(date);

  const base = 'https://polymarket.com/api/crypto/crypto-price';
  const params = new URLSearchParams({
    symbol,
    eventStartTime: isoNoMs(start),
    variant,
    endDate: isoNoMs(end),
  });
  return `${base}?${params.toString()}`;
}

// Polymarket market slug (your BTC 15m up/down example)
let CRYPTO_PRICE_URL = cryptoPriceUrl();
let SLUG = btc15mSlug();
let SHARES_BOUGHT = 0;
let GAMMA_URL = `https://gamma-api.polymarket.com/markets/slug/${SLUG}`;
console.log(SLUG, CRYPTO_PRICE_URL);

// Pyth Hermes latest price endpoint (BTC/USD feed id from Pyth docs)
const PYTH_HERMES_URL =
  "https://hermes.pyth.network/api/latest_price_feeds?ids[]=" +
  "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43";

// CLOB host
const CLOB_HOST = "https://clob.polymarket.com";
const CHAIN_ID = 137;
const SIGNATURE_TYPE = 1; // 0 = EVM/browser; 1 = Magic/email
const FUNDER = '0xA69b1867a00c87928b5A1f6B1c2e9aC2246bD844';
const signer = new Wallet(process.env.PRIVATE_KEY);
const credsP = new ClobClient(CLOB_HOST, CHAIN_ID, signer).createOrDeriveApiKey();
const creds = await credsP; // { key, secret, passphrase }
console.log('Address:', await signer.getAddress());
const client = new ClobClient(CLOB_HOST, CHAIN_ID, signer, creds, SIGNATURE_TYPE, FUNDER);

// Vol model: your assumed BTC 1-minute std dev in USD
// const SIGMA_PER_MIN = 105.30; // adjust based on your own stats
const sigmaConfig = JSON.parse(fs.readFileSync("btc_sigma_1m.json", "utf8"));
const SIGMA_PER_MIN = sigmaConfig.sigmaPerMinUSD || 105.30;
console.log('Loaded sigma per minute', SIGMA_PER_MIN);

// How much edge (in probability points) you’d want vs market to consider betting
const MIN_EDGE = 0.03; // 3%
const MINUTES_LEFT = 5;
const Z_MIN = 0.5;

// ---------- MATH HELPERS ----------

// Quick-and-dirty normal CDF approximation
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

function reset() {
  CRYPTO_PRICE_URL = cryptoPriceUrl();
  SLUG = btc15mSlug();
  GAMMA_URL = `https://gamma-api.polymarket.com/markets/slug/${SLUG}`;
  SHARES_BOUGHT = 0;

  console.log(
    `Reset script to new values: ` +
    `cryptoPriceURL=${CRYPTO_PRICE_URL}, ` +
    `slug=${SLUG}, ` +
    `gammaUrl=${GAMMA_URL}, ` +
    `sharesBought=${SHARES_BOUGHT}`
  );
}

function buyShares() {

}

function reschedule(newInterval) {
  // if (newInterval === interval) return;

  // interval = newInterval;
  // task.stop();
  // task = cron.schedule(`*/${interval} * * * * *`, async () => {
  //   console.log('\n\n\n🥵🥵 running poly bids');
  //   exec(task);
  // });
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
};

const exec = async () => { 
  // 1) Fetch market from Gamma (fields known from your JSON)
  const gammaRes = await fetch(GAMMA_URL);
  if (!gammaRes.ok) {
    throw new Error(`Gamma request failed: ${gammaRes.status} ${gammaRes.statusText}`);
  }
  const market = await gammaRes.json();

  const endMs = new Date(market.endDate).getTime(); // real field: "endDate"
  const nowMs = Date.now();
  const minsLeft = Math.max((endMs - nowMs) / 60000, 0.001); // minutes to expiry (avoid 0)

  console.log("Question:", market.question);
  console.log("End date:", market.endDate);
  console.log("Minutes left:", minsLeft.toFixed(3));

  if (minsLeft < 0.01) {
    await sleep(3000);

    console.log("Current interval is over. Resetting...");
    return reset();
  }

  // 2) Fetch start price (openPrice) from Polymarket crypto-price API
  const cpRes = await fetch(CRYPTO_PRICE_URL);
  if (!cpRes.ok) return;
  const cp = await cpRes.json();

  // ASSUMPTION: openPrice is a top-level numeric field in this JSON
  const startPrice = Number(cp.openPrice);
  if (!Number.isFinite(startPrice)) {
    throw new Error("openPrice is missing or not numeric in crypto-price response");
  }
  console.log("Start price (openPrice):", startPrice);

  // 3) Fetch current BTC price from Pyth Hermes
  const pythRes = await fetch(PYTH_HERMES_URL);
  if (!pythRes.ok) {
    throw new Error(`Pyth request failed: ${pythRes.status} ${pythRes.statusText}`);
  }
  const pythArr = await pythRes.json();
  const pyth0 = pythArr[0];
  const pythPriceObj = pyth0.price; // docs: response[0].price.price, response[0].price.expo

  const raw = Number(pythPriceObj.price);
  const expo = Number(pythPriceObj.expo);
  if (!Number.isFinite(raw) || !Number.isFinite(expo)) {
    throw new Error("Pyth price or expo missing / non-numeric");
  }
  const currentPrice = raw * Math.pow(10, expo); // actual BTC/USD price
  console.log("Current BTC price (Pyth):", currentPrice);
  const relDiff = Math.abs(currentPrice - startPrice) / startPrice;

  if (relDiff > MAX_REL_DIFF) {
    console.log(
      "Price sanity check FAILED. Possible bad data.",
      { startPrice, currentPrice, relDiff }
    );
    return; // stop this iteration
  }

  // 4) Compute probability that end price >= start price (Up)
  // Simple Brownian model: delta ~ N(0, sigma^2 * t)
  const sigmaT = SIGMA_PER_MIN * Math.sqrt(minsLeft); // horizon vol in USD
  const diff = currentPrice - startPrice;
  const z = diff / sigmaT;

  // Probability Up = P(End >= Start) ≈ Φ(z)
  const pUp = normCdf(z);
  const pDown = 1 - pUp;

  console.log('\n');
  console.log("min z-score:", Z_MIN.toFixed(3));
  console.log("z-score:", z.toFixed(3));
  console.log("Model P(Up):", pUp.toFixed(4));
  console.log("Model P(Down):", pDown.toFixed(4));
  console.log('\n');

  if ((Math.abs(z) < 2.5 || Math.abs(z) > 5) && minsLeft.toFixed(3) > MINUTES_LEFT) {
    console.log(`Longer than ${MINUTES_LEFT} minutes left. No trade yet.`);
    return;
  } else {
    reschedule(5);
  }

  // 5) Read CLOB order book for Up token & compare
  const tokenIds = JSON.parse(market.clobTokenIds); // real field in your JSON
  const upTokenId = tokenIds[0]; // first outcome = "Up" (matches outcomes ["Up","Down"])
  const downTokenId = tokenIds[1];

  const [upBook, downBook] = await Promise.all([
    client.getOrderBook(upTokenId),
    client.getOrderBook(downTokenId),
  ]);
  // console.log("Raw Up book snapshot:", JSON.stringify(upBook, null, 2));
  // console.log("Raw Down book snapshot:", JSON.stringify(downBook, null, 2));

  // const { bestBid, bestAsk } = getBestBidAsk(upBook);

  // if (bestBid == null || bestAsk == null) {
  //   console.log("No bids/asks on Up side. No trade.");
  //   return;
  // }
  const { bestAsk: upAsk }   = getBestBidAsk(upBook);
  const { bestAsk: downAsk } = getBestBidAsk(downBook);

  if (upAsk == null && downAsk == null) {
    console.log("No asks on either side. No trade.");
    return;
  }

  // const bid = bestBid;
  // const ask = bestAsk;
  const bid = upAsk;
  const ask = downAsk;
  const mid = upAsk != null && downAsk != null ? (upAsk + downAsk) / 2 : upAsk ?? downAsk; // if one side missing

  console.log(`Up ask/Down ask: ${upAsk?.toFixed(3)} / ${downAsk?.toFixed(3)}, mid≈${mid?.toFixed(3)}`);

  // CHANGED 2: edge based on EV vs ask/bid, NOT mid
  let evBuyUp = null;
  let evShortUp = null;

  if (ask != null) {
    evBuyUp = pUp - ask; // buy Up at ask
    console.log("EV buy Up (pUp - ask):", evBuyUp.toFixed(4));
  } else {
    console.log("No ask: cannot buy Up.");
  }

  if (bid != null) {
    evShortUp = bid - pUp; // short Up at bid
    console.log("EV short Up (bid - pUp):", evShortUp.toFixed(4));
  } else {
    console.log("No bid: cannot short Up.");
  }

  // if (evBuyUp != null && evBuyUp > MIN_EDGE) {
  //   console.log(">>> SIGNAL: BUY UP");
  // } else if (evShortUp != null && evShortUp > MIN_EDGE) {
  //   console.log(">>> SIGNAL: SELL/SHORT UP (or BUY DOWN)");
  // } else {
  //   console.log(">>> No trade: edge too small or missing liquidity");
  // }

  // Directional, buy-only logic
  let candidates = [];

  // Only consider BUY UP if z is clearly positive and we have an ask
  if (z >= Z_MIN && upAsk != null) {
    const evBuyUp = pUp - upAsk;
    console.log(
      `Up ask=${upAsk.toFixed(3)}, EV buy Up (pUp - ask)= ${evBuyUp.toFixed(4)}`
    );
    candidates.push({ side: "UP", ev: evBuyUp, ask: upAsk });
  } else {
    console.log("We don't buy Up here (z too small or no ask).");
  }

  // Only consider BUY DOWN if z is clearly negative and we have an ask
  if (z <= -Z_MIN && downAsk != null) {
    const evBuyDown = pDown - downAsk;
    console.log(
      `Down ask=${downAsk.toFixed(3)}, EV buy Down (pDown - ask)= ${evBuyDown.toFixed(4)}`
    );
    candidates.push({ side: "DOWN", ev: evBuyDown, ask: downAsk });
  } else {
    console.log("We don't buy Down here (z too small in abs value or no ask).");
  }

  // Pick best positive-EV candidate (if any)
  candidates = candidates.filter((c) => c.ev > MIN_EDGE);

  if (minsLeft < 2 && minsLeft > 0.001) {
    const expiresAt = Math.floor(Date.now()/1000) + 15*60; // 15 minutes
    // --- dynamic price & size based on time left (2 minutes window) ---
    const windowSecs = 120;                          // 2 minutes
    const secsLeftRaw = minsLeft * 60;
    const secsLeft = Math.max(0, Math.min(windowSecs, secsLeftRaw));

    // progress goes from 0 (120s left) to 1 (0s left)
    const progress = (windowSecs - secsLeft) / windowSecs;

    const LEVELS = 5; // 5 steps of ~20 seconds
    let level = Math.floor(progress * LEVELS); // 0..8
    level = Math.min(LEVELS - 1, Math.max(0, level)); // clamp to 0..4

    // ---------- NEW: make price aggressiveness depend on |z| ----------
    const zAbs = Math.min(Math.abs(z), 3); // cap at 3σ
    const zFrac = zAbs / 3;                // 0 (weak) .. 1 (very strong)

    // When z is small → base/max prices closer to 0.95/0.97
    // When z is large → base/max prices closer to 0.97/0.99
    const basePriceLow  = 0.95;
    const basePriceHigh = 0.99;
    const maxPriceLow   = 0.96;
    const maxPriceHigh  = 0.99;

    const basePrice =
      basePriceLow + (basePriceHigh - basePriceLow) * zFrac;
    const maxPrice =
      maxPriceLow + (maxPriceHigh - maxPriceLow) * zFrac;

    const baseSize  = 25;
    const maxSize   = 100;

    const priceStep = (maxPrice - basePrice) / (LEVELS - 1);
    const sizeStep  = (maxSize  - baseSize)  / (LEVELS - 1);

    const limitPrice = Number((basePrice + priceStep * level).toFixed(2));
    const orderSize  = Math.round(baseSize + sizeStep * level);

    console.log(
      `Late game mode: secsLeft=${secsLeft.toFixed(1)}, level=${level}, ` +
      `|z|=${zAbs.toFixed(3)}, basePrice=${basePrice.toFixed(3)}, ` +
      `maxPrice=${maxPrice.toFixed(3)}, limitPrice=${limitPrice}, ` +
      `size=${orderSize}`
    );

    if ((pUp >= 0.85 || secsLeft < 7) && z > 0.15) {
      if (SHARES_BOUGHT <= 500) {
        console.log('>>> Not much time left. Buying UP with high probability.');
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
        console.log("UP GTD:", resp);

        SHARES_BOUGHT += orderSize;
      }
    }

    if ((pDown >= 0.85 || secsLeft < 7) && z < 0.15) {
      if (SHARES_BOUGHT <= 500) {
        console.log('>>> Not much time left. Buying DOWN with high probability.');
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
        console.log("DOWN GTD:", resp);

        SHARES_BOUGHT += orderSize;
      }
    }
  }
  if (candidates.length === 0) {
    console.log(">>> No trade: no side with enough edge in the right direction.");
    return;
  }

  const best = candidates.reduce((a, b) => (b.ev > a.ev ? b : a));

  console.log(
    `>>> SIGNAL: BUY ${best.side} @ ${best.ask.toFixed(
      3
    )}, EV=${best.ev.toFixed(4)}`
  );

  if (SHARES_BOUGHT <= 500) {
    const expiresAt = Math.floor(Date.now()/1000) + 15*60; // 15 minutes
    const resp = await client.createAndPostOrder(
      {
        tokenID: best.side === 'UP' ? upTokenId : downTokenId,
        price: best.ask.toFixed(2),
        side: Side.BUY,
        size: 100,
        expiration: String(expiresAt),
      },
      { tickSize: "0.01", negRisk: false },
      OrderType.GTD
    );
    SHARES_BOUGHT += 100;
  }
};

let task = cron.schedule(`*/${interval} * * * * *`, async () => {
  console.log("\n\n\n=======================")
  console.log('🥵🥵 running poly bids');
  exec();
});
