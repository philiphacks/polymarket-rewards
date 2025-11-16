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

// ---------- WINDOW CONFIG (15m + 60m) ----------

// **NEW** per-window config (time behaviour, slug, crypto-price variant)
const MARKET_WINDOWS = [ // **NEW**
  {
    key: "15m",                     // **NEW**
    minutes: 15,                    // **NEW**
    slugPart: "15m",                // **NEW**
    cryptoVariant: "fifteen",       // **NEW** matches your current code
    MINUTES_LEFT: 3,                // **NEW** only act in last X mins unless |z| big
    Z_MAX_FAR_MINUTES: 10,         // **NEW** for dynamicZMax
    Z_MAX_NEAR_MINUTES: 3,         // **NEW**
    LATE_TRIGGER_MIN: 2,           // **NEW** late-game mode below this
    MAX_MINUTES_BEFORE_START_TRADING: 14, // **NEW** was `minsLeft > 14` early-return
  },
  {
    key: "60m",                     // **NEW**
    minutes: 60,                    // **NEW**
    slugPart: "60m",                // **NEW**
    cryptoVariant: "sixty",         // **NEW** TODO: confirm actual variant string in Polymarket API
    MINUTES_LEFT: 12,              // **NEW** ~last 20% of hour
    Z_MAX_FAR_MINUTES: 45,         // **NEW**
    Z_MAX_NEAR_MINUTES: 8,         // **NEW**
    LATE_TRIGGER_MIN: 8,           // **NEW** late-game ~last 8 minutes
    MAX_MINUTES_BEFORE_START_TRADING: 55, // **NEW**
  },
];

// Max shares per market *per asset* and per window
const MAX_SHARES_PER_MARKET = {    // **NEW**
  "15m": {                         // **NEW**
    BTC: 400,
    ETH: 400,
    SOL: 400,
    XRP: 400,
  },
  "60m": {                         // **NEW** you can tweak these separately
    BTC: 300,
    ETH: 300,
    SOL: 300,
    XRP: 300,
  },
};

// Time / z thresholds & sanity checks
const MIN_EDGE_EARLY = 0.08;  // minsLeft > MINUTES_LEFT (per window)
const MIN_EDGE_LATE  = 0.05;  // minsLeft <= MINUTES_LEFT (per window)
const Z_MIN = 0.5;            // min |z| to even consider directional trade
const Z_MAX_FAR = 3.0;
const Z_MAX_NEAR = 1.7;
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
function loadSigmaConfig() {
  try {
    const raw = fs.readFileSync("btc_sigma_1m.json", "utf8");
    const parsed = JSON.parse(raw);
    console.log(
      "[VOL] Loaded sigma file keys:",
      Object.keys(parsed)
    );
    return parsed;
  } catch (err) {
    console.error("[VOL] Failed to load btc_sigma_1m.json:", err);
    return {};
  }
}

// mutable sigmaConfig that can be reloaded
let sigmaConfig = loadSigmaConfig();
console.log("Loaded sigma file keys:", Object.keys(sigmaConfig));

// ---------- UTILS ----------

// **NEW**: generic "snap to window" time utilities
function currentWindowStartUTC(windowMinutes, date = new Date()) { // **NEW**
  const d = new Date(date);
  const mins = d.getUTCMinutes();
  const snapped = Math.floor(mins / windowMinutes) * windowMinutes;
  d.setUTCMinutes(snapped, 0, 0);
  return d;
}

function currentWindowEndUTC(windowMinutes, date = new Date()) {   // **NEW**
  const start = currentWindowStartUTC(windowMinutes, date);
  return new Date(start.getTime() + windowMinutes * 60 * 1000);
}

function currentWindowStartUnix(windowMinutes, date = new Date()) { // **NEW**
  const start = currentWindowStartUTC(windowMinutes, date);
  return Math.floor(start.getTime() / 1000);
}

// Generic slug for up/down markets per window
function cryptoSlugForWindow(slugPrefix, windowCfg, date = new Date()) { // **NEW**
  return `${slugPrefix}-updown-${windowCfg.slugPart}-${currentWindowStartUnix(windowCfg.minutes, date)}`;
}

// ISO without milliseconds
function isoNoMs(d) {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

// Polymarket crypto-price URL for a symbol + window
function cryptoPriceUrlForWindow({ symbol, windowCfg, date = new Date() }) { // **NEW**
  const start = currentWindowStartUTC(windowCfg.minutes, date);
  const end = currentWindowEndUTC(windowCfg.minutes, date);

  const base = "https://polymarket.com/api/crypto/crypto-price";
  const params = new URLSearchParams({
    symbol,
    eventStartTime: isoNoMs(start),
    variant: windowCfg.cryptoVariant,
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

function dynamicZMax(minsLeft, windowCfg) { // **NEW** now window-aware
  const farM = windowCfg.Z_MAX_FAR_MINUTES;
  const nearM = windowCfg.Z_MAX_NEAR_MINUTES;

  if (minsLeft >= farM) return Z_MAX_FAR;
  if (minsLeft <= nearM) return Z_MAX_NEAR;

  const t = (farM - minsLeft) / (farM - nearM);
  return Z_MAX_FAR - t * (Z_MAX_FAR - Z_MAX_NEAR);
}

// helper to check if we can place an order given caps
function canPlaceOrder(state, slug, side, size, assetSymbol, windowKey) { // **NEW arg windowKey**
  const totalCap = getMaxSharesForMarket(windowKey, assetSymbol);         // **NEW**

  const totalBefore = state.sharesBoughtBySlug[slug] || 0;

  const pos = state.sideSharesBySlug[slug] || { UP: 0, DOWN: 0 };
  const upBefore = pos.UP || 0;
  const downBefore = pos.DOWN || 0;

  const netBefore = upBefore - downBefore;
  const sideSign = side === "UP" ? 1 : -1;
  const netAfter = netBefore + sideSign * size;

  const totalAfter = totalBefore + size;

  // Case 1: within total cap => always allowed
  if (totalAfter <= totalCap) {
    return {
      ok: true,
      reason: "within_cap",
      totalBefore,
      totalAfter,
      netBefore,
      netAfter,
    };
  }

  // Case 2: exceeding total cap, only allow if hedge (reduces |net|)
  if (Math.abs(netAfter) < Math.abs(netBefore)) {
    return {
      ok: true,
      reason: "hedge_beyond_cap",
      totalBefore,
      totalAfter,
      netBefore,
      netAfter,
    };
  }

  // Otherwise: reject – would add risk beyond cap
  return {
    ok: false,
    reason: "risk_increase_beyond_cap",
    totalBefore,
    totalAfter,
    netBefore,
    netAfter,
  };
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
  const floorByAsset = {
    "BTC": 42,
    "ETH": 2.3,
    "SOL": 0.125,
    "XRP": 0.0017,
  };

  const assets = sigmaConfig.assets || {};
  const entry = assets[volKey];

  let sigma = entry && typeof entry.sigmaPerMinUSD === "number"
    ? entry.sigmaPerMinUSD
    : floorByAsset[volKey];

  // Enforce floor
  const floor = floorByAsset[volKey];
  if (typeof floor === "number" && typeof sigma === "number") {
    sigma = Math.max(sigma, floor);
  }

  return sigma;
}

function getExistingSide(state, slug) {
  const sidePos = state.sideSharesBySlug?.[slug];
  if (!sidePos) return null;

  const up = sidePos.UP || 0;
  const down = sidePos.DOWN || 0;

  if (up > down) return "UP";
  if (down > up) return "DOWN";
  return null; // roughly flat
}

// helper to bump side position after trade
function addPosition(state, slug, side, size) {
  if (!state.sideSharesBySlug[slug]) {
    state.sideSharesBySlug[slug] = { UP: 0, DOWN: 0 };
  }
  state.sideSharesBySlug[slug][side] =
    (state.sideSharesBySlug[slug][side] || 0) + size;
}

function requiredLateProb(secsLeft) {
  const maxSecs = 120;   // 2 minutes window
  const pHigh = 0.90;    // require 90% when 2m left
  const pLow  = 0.80;    // allow 80% right at expiry

  // clamp secsLeft to [0, maxSecs]
  const clamped = Math.max(0, Math.min(maxSecs, secsLeft));

  // t=0 at far end (2m), t=1 at expiry
  const t = (maxSecs - clamped) / maxSecs;

  // linear interpolation: pHigh -> pLow
  return pHigh + (pLow - pHigh) * t;
}

// ---------- PER-ASSET STATE ----------
const stateBySymbol = {}; // symbol -> { [windowKey]: windowState }  // **NEW comment**

function getMaxSharesForMarket(windowKey, symbol) { // **NEW signature**
  const perWindow = MAX_SHARES_PER_MARKET[windowKey];
  if (!perWindow) return 500;
  return perWindow[symbol] ?? 500;
}

// Initialize/Reset state for an asset + window
function resetStateForAssetAndWindow(asset, windowCfg) { // **NEW**
  const slug = cryptoSlugForWindow(asset.slugPrefix, windowCfg);    // **NEW**
  const cryptoUrl = cryptoPriceUrlForWindow({                      // **NEW**
    symbol: asset.symbol,
    windowCfg,
  });
  const gammaUrl = `https://gamma-api.polymarket.com/markets/slug/${slug}`;

  if (!stateBySymbol[asset.symbol]) {                              // **NEW**
    stateBySymbol[asset.symbol] = {};                              // **NEW**
  }

  stateBySymbol[asset.symbol][windowCfg.key] = {                   // **NEW**
    slug,
    windowKey: windowCfg.key,   // **NEW**
    cryptoPriceUrl: cryptoUrl,
    gammaUrl,
    sharesBoughtBySlug: { [slug]: 0 }, // track per-market
    sideSharesBySlug: { [slug]: { UP: 0, DOWN: 0 } },
    resetting: false,
    cpData: null,
    marketMeta: null,
  };

  console.log(
    `[${asset.symbol}][${windowCfg.key}] Reset: slug=${slug}, cryptoPriceUrl=${cryptoUrl}, gammaUrl=${gammaUrl}`
  );
}

// Ensure state exists
function ensureState(asset, windowCfg) { // **NEW signature**
  if (!stateBySymbol[asset.symbol] ||
      !stateBySymbol[asset.symbol][windowCfg.key]) {
    resetStateForAssetAndWindow(asset, windowCfg);
  }
  return stateBySymbol[asset.symbol][windowCfg.key];
}

// ---------- CORE EXECUTION PER ASSET + WINDOW ----------
async function execForAssetWindow(asset, windowCfg) { // **NEW (replaces execForAsset)**
  const state = ensureState(asset, windowCfg);
  if (state.resetting) return;

  const { slug, cryptoPriceUrl, gammaUrl } = state;

  console.log(`\n\n===== ${asset.symbol} [${windowCfg.key}] | slug=${slug} =====`);

  // 1) Fetch/cached market meta from Gamma
  if (!state.marketMeta || state.marketMeta.slug !== slug) {
    const gammaRes = await fetch(gammaUrl);
    if (!gammaRes.ok) {
      console.log(
        `[${asset.symbol}][${windowCfg.key}] Gamma request failed: ${gammaRes.status} ${gammaRes.statusText}`
      );
      return;
    }
    const market = await gammaRes.json();
    const endMs = new Date(market.endDate).getTime();
    const tokenIds = JSON.parse(market.clobTokenIds);

    state.marketMeta = {
      id: market.id,
      slug,
      question: market.question,
      endMs,
      tokenIds,
      endDate: market.endDate,
    };

    console.log(
      `[${asset.symbol}][${windowCfg.key}] Cached marketMeta for slug=${slug}, id=${market.id}`
    );
  }

  const { question, endMs, endDate, tokenIds } = state.marketMeta;
  const nowMs = Date.now();
  const minsLeft = Math.max((endMs - nowMs) / 60000, 0.001);

  console.log(`[${asset.symbol}][${windowCfg.key}] Question:`, question);
  console.log(`[${asset.symbol}][${windowCfg.key}] End date:`, endDate);
  console.log(`[${asset.symbol}][${windowCfg.key}] Minutes left:`, minsLeft.toFixed(3));

  if (minsLeft > windowCfg.MAX_MINUTES_BEFORE_START_TRADING) return; // **NEW**

  // If market basically over, wait a bit and reset to next window
  if (minsLeft < 0.01) {
    state.resetting = true;
    console.log(`[${asset.symbol}][${windowCfg.key}] Interval over. Resetting in 30s...`);
    await sleep(30_000);
    resetStateForAssetAndWindow(asset, windowCfg);
    return;
  }

  // 2) Fetch start price (openPrice) from Polymarket crypto-price API
  //    with simple per-asset-per-slug cache
  let startPrice;

  if (
    state.cpData &&
    Number.isFinite(Number(state.cpData.openPrice)) &&
    Number(state.cpData.openPrice) > 0
  ) {
    startPrice = Number(state.cpData.openPrice);
    console.log(
      `[${asset.symbol}][${windowCfg.key}] Using CACHED start price (openPrice):`,
      startPrice
    );
  } else {
    const cpRes = await fetch(cryptoPriceUrl);

    if (cpRes.status === 429) {
      console.log(
        `[${asset.symbol}][${windowCfg.key}] crypto-price 429 (rate limited). Sleeping 3s and skipping this tick.`
      );
      await sleep(3000);
      return;
    }

    if (!cpRes.ok) {
      console.log(
        `[${asset.symbol}][${windowCfg.key}] crypto-price failed: ${cpRes.status} ${cpRes.statusText}`
      );
      return;
    }
    const cp = await cpRes.json();
    const candidate = Number(cp.openPrice);

    if (!Number.isFinite(candidate) || candidate <= 0) {
      console.log(
        `[${asset.symbol}][${windowCfg.key}] openPrice missing / non-numeric / non-positive (=${cp.openPrice}). Not caching; skipping this tick.`
      );
      return;
    }

    state.cpData = {
      ...cp,
      _cachedAt: Date.now(),
    };

    startPrice = candidate;
    console.log(
      `[${asset.symbol}][${windowCfg.key}] Start price (openPrice) fetched & cached:`,
      startPrice
    );
  }

  // 3) Fetch current price from Pyth Hermes (per-asset feed ID)
  const pythUrl =
    "https://hermes.pyth.network/api/latest_price_feeds?ids[]=" + asset.pythId;

  const pythRes = await fetch(pythUrl);
  if (!pythRes.ok) {
    console.log(
      `[${asset.symbol}][${windowCfg.key}] Pyth request failed: ${pythRes.status} ${pythRes.statusText}`
    );
    return;
  }
  const pythArr = await pythRes.json();
  const pyth0 = pythArr[0];
  const pythPriceObj = pyth0.price;

  const raw = Number(pythPriceObj.price);
  const expo = Number(pythPriceObj.expo);
  if (!Number.isFinite(raw) || !Number.isFinite(expo)) {
    console.log(`[${asset.symbol}][${windowCfg.key}] Pyth price/expo missing`);
    return;
  }
  const currentPrice = raw * Math.pow(10, expo);
  console.log(`[${asset.symbol}][${windowCfg.key}] Current price (Pyth):`, currentPrice);

  // Sanity check: Polymarket vs Pyth
  const relDiff = Math.abs(currentPrice - startPrice) / startPrice;
  if (relDiff > MAX_REL_DIFF) {
    console.log(
      `[${asset.symbol}][${windowCfg.key}] Price sanity FAILED (>${MAX_REL_DIFF * 100}%). Skipping.`,
      { startPrice, currentPrice, relDiff }
    );
    return;
  }

  // 4) Compute probability Up using per-asset σ
  const SIGMA_PER_MIN = getSigmaPerMinUSD(asset.symbol);
  console.log(`[${asset.symbol}][${windowCfg.key}] Got σ ${SIGMA_PER_MIN} (1 stdev)`);
  const sigmaT = SIGMA_PER_MIN * Math.sqrt(minsLeft);
  const diff = currentPrice - startPrice;
  const z = diff / sigmaT;
  const pUp = normCdf(z);
  const pDown = 1 - pUp;

  console.log(`[${asset.symbol}][${windowCfg.key}] min z-score:`, Z_MIN.toFixed(3));
  console.log(`[${asset.symbol}][${windowCfg.key}] z-score:`, z.toFixed(3));
  console.log(`[${asset.symbol}][${windowCfg.key}] Model P(Up):`, pUp.toFixed(4));
  console.log(`[${asset.symbol}][${windowCfg.key}] Model P(Down):`, pDown.toFixed(4));

  const zMaxDynamic = dynamicZMax(minsLeft, windowCfg); // **NEW**
  console.log(
    `[${asset.symbol}][${windowCfg.key}] dynamic Z_MAX (minsLeft=${minsLeft.toFixed(2)}): ${zMaxDynamic.toFixed(3)}`
  );

  // If |z| small AND still early → no trade
  if ((Math.abs(z) < zMaxDynamic || Math.abs(z) > 5) &&
      minsLeft > windowCfg.MINUTES_LEFT) { // **NEW**
    console.log(
      `[${asset.symbol}][${windowCfg.key}] Earlier than ${windowCfg.MINUTES_LEFT} mins left and |z| not huge. No trade yet.`
    );
    return;
  }

  // 5) Order books
  const upTokenId = tokenIds[0];
  const downTokenId = tokenIds[1];

  const [upBook, downBook] = await Promise.all([
    client.getOrderBook(upTokenId),
    client.getOrderBook(downTokenId),
  ]);

  const { bestAsk: upAsk } = getBestBidAsk(upBook);
  const { bestAsk: downAsk } = getBestBidAsk(downBook);

  if (upAsk == null && downAsk == null) {
    console.log(`[${asset.symbol}][${windowCfg.key}] No asks on either side. No trade.`);
    return;
  }

  const mid =
    upAsk != null && downAsk != null ? (upAsk + downAsk) / 2 : upAsk ?? downAsk;
  console.log(
    `[${asset.symbol}][${windowCfg.key}] Up ask / Down ask: ${upAsk?.toFixed(
      3
    )} / ${downAsk?.toFixed(3)}, mid≈${mid?.toFixed(3)}`
  );

  const existingSide = getExistingSide(state, slug);
  console.log(
    `[${asset.symbol}][${windowCfg.key}] Existing net side: ${existingSide || "FLAT"}`
  );

  // Directional buy-only logic (same as before)
  let candidates = [];

  if (z >= Z_MIN && upAsk != null) {
    const evBuyUp = pUp - upAsk;
    console.log(
      `[${asset.symbol}][${windowCfg.key}] Up ask=${upAsk.toFixed(
        3
      )}, EV buy Up (pUp - ask)= ${evBuyUp.toFixed(4)}`
    );
    candidates.push({ side: "UP", ev: evBuyUp, ask: upAsk });
  } else {
    console.log(`[${asset.symbol}][${windowCfg.key}] We don't buy Up here (z too small or no ask).`);
  }

  if (z <= -Z_MIN && downAsk != null) {
    const evBuyDown = pDown - downAsk;
    console.log(
      `[${asset.symbol}][${windowCfg.key}] Down ask=${downAsk.toFixed(
        3
      )}, EV buy Down (pDown - ask)= ${evBuyDown.toFixed(4)}`
    );
    candidates.push({ side: "DOWN", ev: evBuyDown, ask: downAsk });
  } else {
    console.log(
      `[${asset.symbol}][${windowCfg.key}] We don't buy Down here (|z| too small or no ask).`
    );
  }

  // Filter by EV threshold
  const minEdge = minsLeft > windowCfg.MINUTES_LEFT ? MIN_EDGE_EARLY : MIN_EDGE_LATE; // **NEW**
  candidates = candidates.filter((c) => c.ev > minEdge);

  // ---------- Late-game "all-in-ish" mode ----------
  if (Math.abs(z) > zMaxDynamic || (minsLeft < windowCfg.LATE_TRIGGER_MIN && minsLeft > 0.001)) { // **NEW**
    const expiresAt = Math.floor(Date.now() / 1000) + 15 * 60;

    const secsLeft = minsLeft * 60;
    const pReq = requiredLateProb(secsLeft);

    let lateSide = null;
    let sideProb = null;
    let sideAsk = null;

    if (pUp >= pReq && z > Z_MIN) {
      lateSide = "UP";
      sideProb = pUp;
      sideAsk = upAsk || 0.99;
    } else if (pDown >= pReq && z < -Z_MIN) {
      lateSide = "DOWN";
      sideProb = pDown;
      sideAsk = downAsk || 0.99;
    }

    if (!lateSide || sideAsk == null) {
      console.log(`[${asset.symbol}][${windowCfg.key}] Late game: no eligible side/ask.`);
    } else {
      // Hybrid layered model
      const LAYER_OFFSETS = [-0.03, -0.01, 0.0];
      const LAYER_SIZES = [40, 40, 20];
      const MIN_LATE_LAYER_EV = 0.03;

      console.log(
        `[${asset.symbol}][${windowCfg.key}] Late game hybrid: side=${lateSide}, ` +
        `prob=${sideProb.toFixed(4)}, ask=${sideAsk.toFixed(3)}`
      );

      for (let i = 0; i < LAYER_OFFSETS.length; i++) {
        let target = sideAsk + LAYER_OFFSETS[i];
        target = Math.max(0.01, Math.min(target, 0.99));

        const ev = sideProb - target;
        // if (ev < MIN_LATE_LAYER_EV) { ... }

        let layerSize = LAYER_SIZES[i];
        const capCheck = canPlaceOrder(state, slug, lateSide, layerSize, asset.symbol, windowCfg.key); // **NEW windowKey**
        if (!capCheck.ok) {
          console.log(
            `[${asset.symbol}][${windowCfg.key}] Skipping layer ${i}; cap hit and not hedging. ` +
            `(reason=${capCheck.reason}, totalBefore=${capCheck.totalBefore}, totalAfter=${capCheck.totalAfter}, ` +
            `netBefore=${capCheck.netBefore}, netAfter=${capCheck.netAfter})`
          );
          continue;
        }

        if (capCheck.reason === "hedge_beyond_cap") {
          console.log(
            `[${asset.symbol}][${windowCfg.key}] Layer ${i} allowed beyond cap because it reduces net exposure. ` +
            `(net ${capCheck.netBefore} -> ${capCheck.netAfter}, total ${capCheck.totalBefore} -> ${capCheck.totalAfter})`
          );
        }

        const limitPrice = Number(target.toFixed(2));

        console.log(
          `[${asset.symbol}][${windowCfg.key}] Late layer ${i}: BUY ${lateSide} @ ${limitPrice}, ` +
          `size=${layerSize}, EV=${ev.toFixed(4)}`
        );

        const tokenID = lateSide === "UP" ? upTokenId : downTokenId;

        try {
          const resp = await client.createAndPostOrder(
            {
              tokenID,
              price: limitPrice,
              side: Side.BUY,
              size: layerSize,
              expiration: String(expiresAt),
            },
            { tickSize: "0.01", negRisk: false },
            OrderType.GTD
          );

          console.log(`[${asset.symbol}][${windowCfg.key}] LATE LAYER ${i} RESP:`, resp);
          state.sharesBoughtBySlug[slug] =
            (state.sharesBoughtBySlug[slug] || 0) + layerSize;
          addPosition(state, slug, lateSide, layerSize);
        } catch (err) {
          console.log(
            `[${asset.symbol}][${windowCfg.key}] Error placing late layer ${i}:`,
            err?.message || err
          );
        }
      }
    }
  }

  // ---------- Normal EV-based entries ----------
  if (candidates.length === 0) {
    console.log(
      `[${asset.symbol}][${windowCfg.key}] No trade: no side with enough edge in the right direction.`
    );
    return;
  }

  const best = candidates.reduce((a, b) => (b.ev > a.ev ? b : a));
  const size = 100;
  const capCheck = canPlaceOrder(state, slug, best.side, size, asset.symbol, windowCfg.key); // **NEW windowKey**
  if (!capCheck.ok) {
    console.log(
      `[${asset.symbol}][${windowCfg.key}] Skipping EV buy; cap hit and not hedging. ` +
      `(reason=${capCheck.reason}, totalBefore=${capCheck.totalBefore}, totalAfter=${capCheck.totalAfter}, ` +
      `netBefore=${capCheck.netBefore}, netAfter=${capCheck.netAfter})`
    );
    return;
  }
  if (capCheck.reason === "hedge_beyond_cap") {
    console.log(
      `[${asset.symbol}][${windowCfg.key}] EV buy allowed beyond total cap because it reduces net exposure. ` +
      `(net ${capCheck.netBefore} -> ${capCheck.netAfter}, total ${capCheck.totalBefore} -> ${capCheck.totalAfter})`
    );
  }

  console.log(
    `[${asset.symbol}][${windowCfg.key}] >>> SIGNAL: BUY ${best.side} @ ${best.ask.toFixed(
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

  console.log(`[${asset.symbol}][${windowCfg.key}] ORDER RESP:`, resp);
  const currentShares = state.sharesBoughtBySlug[slug] || 0;
  state.sharesBoughtBySlug[slug] = currentShares + size;
  addPosition(state, slug, best.side, size);
}

// ---------- MAIN SCHEDULER ----------
async function execAll() {
  console.log("\n\n\n======================= RUN =======================");
  for (const asset of ASSETS) {
    for (const windowCfg of MARKET_WINDOWS) { // **NEW** loop over 15m + 60m
      try {
        await execForAssetWindow(asset, windowCfg); // **NEW**
      } catch (err) {
        console.error(`[${asset.symbol}][${windowCfg.key}] ERROR:`, err);
      }
    }
  }
}

cron.schedule(`*/${interval} * * * * *`, async () => {
  await execAll().catch((err) => {
    console.error('Fatal error in main():', err);
    process.exit(1);
  });
});

cron.schedule("0 0 */2 * * *", () => {
  console.log("\n[VOL] Reloading btc_sigma_1m.json (2h refresh)...");
  sigmaConfig = loadSigmaConfig();
});
