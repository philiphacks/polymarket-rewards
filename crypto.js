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
const MAX_SHARES_PER_MARKET = {
  BTC: 600,
  ETH: 300,
  SOL: 300,
  XRP: 200,
};

// Time / z thresholds & sanity checks
const MINUTES_LEFT = 3;    // only act in last X minutes (unless |z| big)
const MIN_EDGE_EARLY = 0.05;  // minsLeft > MINUTES_LEFT
const MIN_EDGE_LATE  = 0.03;  // minsLeft <= MINUTES_LEFT
const Z_MIN = 0.5;         // min |z| to even consider directional trade
// const Z_MAX = 1.7;         // if |z| >= this, ignore MINUTES_LEFT condition
const Z_MAX_FAR_MINUTES = 6;
const Z_MAX_NEAR_MINUTES = 3;
const Z_HUGE = 3.0;
const Z_MAX_FAR = 2.5;
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

// **NEW** mutable sigmaConfig that can be reloaded
let sigmaConfig = loadSigmaConfig();
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

function dynamicZMax(minsLeft) {
  if (minsLeft >= Z_MAX_FAR_MINUTES) return Z_MAX_FAR;
  if (minsLeft <= Z_MAX_NEAR_MINUTES) return Z_MAX_NEAR;

  const t =
    (Z_MAX_FAR_MINUTES - minsLeft) /
    (Z_MAX_FAR_MINUTES - Z_MAX_NEAR_MINUTES);
  return Z_MAX_FAR - t * (Z_MAX_FAR - Z_MAX_NEAR);
}

// helper to check if we can place an order given caps
function canPlaceOrder(state, slug, side, size, assetSymbol) {
  const totalCap = getMaxSharesForMarket(assetSymbol);

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
    "BTC": 45,
    "ETH": 2.5,
    "SOL": 0.125,
    "XRP": 0.002,
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

// **NEW**: helper to bump side position after trade
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
  const pLow  = 0.85;    // allow 85% right at expiry

  // clamp secsLeft to [0, maxSecs]
  const clamped = Math.max(0, Math.min(maxSecs, secsLeft));

  // t=0 at far end (2m), t=1 at expiry
  const t = (maxSecs - clamped) / maxSecs;

  // linear interpolation: pHigh -> pLow
  return pHigh + (pLow - pHigh) * t;
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
    sideSharesBySlug: { [slug]: { UP: 0, DOWN: 0 } },
    resetting: false,
    cpData: null,
    marketMeta: null,
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

function getMaxSharesForMarket(volKey) {
  return MAX_SHARES_PER_MARKET[volKey] || 500;
}

// ---------- CORE EXECUTION PER ASSET ----------
async function execForAsset(asset) {
  const state = ensureState(asset);
  if (state.resetting) return;

  const { slug, cryptoPriceUrl, gammaUrl } = state;

  console.log(`\n\n===== ${asset.symbol} | slug=${slug} =====`);

  // 1) Fetch/cached market meta from Gamma
  if (!state.marketMeta || state.marketMeta.slug !== slug) {
    const gammaRes = await fetch(gammaUrl);
    if (!gammaRes.ok) {
      console.log(
        `[${asset.symbol}] Gamma request failed: ${gammaRes.status} ${gammaRes.statusText}`
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
      endDate: market.endDate
    };

    console.log(
      `[${asset.symbol}] Cached marketMeta for slug=${slug}, id=${market.id}`
    );
  }

  const { question, endMs, endDate, tokenIds } = state.marketMeta;
  const nowMs = Date.now();
  const minsLeft = Math.max((endMs - nowMs) / 60000, 0.001);

  console.log(`[${asset.symbol}] Question:`, question);
  console.log(`[${asset.symbol}] End date:`, endDate);
  console.log(`[${asset.symbol}] Minutes left:`, minsLeft.toFixed(3));

  if (minsLeft > 14) return;

  // If market basically over, wait a bit and reset to next 15m market
  if (minsLeft < 0.01) {
    state.resetting = true;
    console.log(`[${asset.symbol}] Interval over. Resetting in 30s...`);
    await sleep(30_000);
    resetStateForAsset(asset);
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
  } else {
    const cpRes = await fetch(cryptoPriceUrl);

    if (cpRes.status === 429) {
      console.log(
        `[${asset.symbol}] crypto-price 429 (rate limited). Sleeping 3s and skipping this tick.`
      );
      await sleep(3000);
      return;
    }

    if (!cpRes.ok) {
      console.log(
        `[${asset.symbol}] crypto-price failed: ${cpRes.status} ${cpRes.statusText}`
      );
      return;
    }
    const cp = await cpRes.json();
    const candidate = Number(cp.openPrice);

    if (!Number.isFinite(candidate) || candidate <= 0) {
      console.log(
        `[${asset.symbol}] openPrice missing / non-numeric / non-positive (=${cp.openPrice}). Not caching; skipping this tick.`
      );
      return;
    }

    state.cpData = {
      ...cp,
      _cachedAt: Date.now(),
    };

    startPrice = candidate;
    console.log(
      `[${asset.symbol}] Start price (openPrice) fetched & cached:`,
      startPrice
    );
  }

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
  console.log(`[${asset.symbol}] Open price $${startPrice.toFixed(5)} vs current price (Pyth) $${currentPrice.toFixed(5)}`);

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
  const SIGMA_PER_MIN = getSigmaPerMinUSD(asset.symbol);
  const sigmaT = SIGMA_PER_MIN * Math.sqrt(minsLeft);
  const diff = currentPrice - startPrice;
  const z = diff / sigmaT;
  const pUp = normCdf(z);
  const pDown = 1 - pUp;

  console.log(`[${asset.symbol}] σ ${SIGMA_PER_MIN.toFixed(5)}`, `| z-score:`, z.toFixed(3), `| Model P(Up):`, pUp.toFixed(4), `| Model P(Down):`, pDown.toFixed(4));

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
    console.log(`[${asset.symbol}] No asks on either side. No trade.`);
    return;
  }

  const zMaxDynamic = dynamicZMax(minsLeft);
  const absZ = Math.abs(z);

  // If |z| small AND still early → no trade
  if (
    minsLeft > 5 ||                        // too early, always skip
    (minsLeft > MINUTES_LEFT && minsLeft <= 5 && absZ < zMaxDynamic) || // 3–5m, z not huge
    (minsLeft <= MINUTES_LEFT && absZ < Z_MIN)               // ≤3m, z not big enough
  ) {
    const evUp = upAsk != null ? pUp - upAsk : 0;
    const evDown = downAsk != null ? pDown - downAsk : 0;
    console.log(
      `[${asset.symbol}] Skip: minsLeft=${minsLeft.toFixed(2)}, |z|=${absZ.toFixed(
        3
      )}, Z_HUGE=${Z_HUGE}, Z_MAXdyn=${zMaxDynamic.toFixed(3)}, 
      EV buy Up (pUp - ask) = ${evUp.toFixed(4)}, 
      EV buy Down (pDown - ask)= ${evDown.toFixed(4)}`
    );
    return;
  }

  const mid =
    upAsk != null && downAsk != null ? (upAsk + downAsk) / 2 : upAsk ?? downAsk;
  console.log(
    `[${asset.symbol}] Up ask / Down ask: ${upAsk?.toFixed(
      3
    )} / ${downAsk?.toFixed(3)}, mid≈${mid?.toFixed(3)}`
  );

  const existingSide = getExistingSide(state, slug);
  console.log(
    `[${asset.symbol}] Existing net side: ${existingSide || "FLAT"}`
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
  const minEdge = minsLeft > MINUTES_LEFT ? MIN_EDGE_EARLY : MIN_EDGE_LATE;
  candidates = candidates.filter((c) => c.ev > minEdge);

  // ---------- Late-game "all-in-ish" mode ----------
  if (Math.abs(z) > zMaxDynamic || (minsLeft < 2 && minsLeft > 0.001)) {
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
      console.log(`[${asset.symbol}] Late game: no eligible side/ask.`);
    } else {
      // Hybrid layered model
      // Target layer "anchor" prices in probability space.
      // We will clamp them against current best ask and EV checks.
      // const LAYER_ANCHORS = [0.96, 0.98, 0.99];

      // TODO: should we ever bid 99c? if that is a losing trade it's pretty bad
      // const LAYER_OFFSETS = [-0.03, -0.02, -0.01, 0.0];
      // const MIN_LATE_LAYER_EV = 0.03;
      const LAYER_OFFSETS = [-0.02, -0.01, 0, +0.01];
      const LAYER_SIZES = [40, 40, 20, 10];
      // const LAYER_MIN_EV  = [0.011, 0.010, 0.005, 0.000];
      const LAYER_MIN_EV = [0.008, 0.006, 0.004, 0.000];
      // const LAYER_MIN_EV = [0.006, 0.004, 0.002, 0.000];

      console.log(
        `[${asset.symbol}] Late game hybrid: side=${lateSide}, ` +
        `prob=${sideProb.toFixed(4)}, ask=${sideAsk.toFixed(3)}`
      );

      for (let i = 0; i < LAYER_OFFSETS.length; i++) {
        // Start from the larger of: current best ask, layer anchor
        let target = sideAsk + LAYER_OFFSETS[i];
        target = Math.max(0.01, Math.min(target, 0.99));

        const ev = sideProb - target;
        const minEv = LAYER_MIN_EV[i];
        if (ev < minEv) {
          console.log(
            `[${asset.symbol}] Layer ${i}: skip @${target.toFixed(
              2
            )} (EV=${ev.toFixed(4)} < ${minEv}).`
          );
          continue;
        }

        let layerSize = LAYER_SIZES[i];
        const capCheck = canPlaceOrder(state, slug, lateSide, layerSize, asset.symbol);
        if (!capCheck.ok) {
          console.log(
            `[${asset.symbol}] Skipping layer ${i}; cap hit and not hedging. ` +
            `(reason=${capCheck.reason}, totalBefore=${capCheck.totalBefore}, totalAfter=${capCheck.totalAfter}, ` +
            `netBefore=${capCheck.netBefore}, netAfter=${capCheck.netAfter})`
          );
          continue;
        }

        if (capCheck.reason === "hedge_beyond_cap") {
          console.log(
            `[${asset.symbol}] Layer ${i} allowed beyond cap because it reduces net exposure. ` +
            `(net ${capCheck.netBefore} -> ${capCheck.netAfter}, total ${capCheck.totalBefore} -> ${capCheck.totalAfter})`
          );
        }

        const limitPrice = Number(target.toFixed(2));

        console.log(
          `[${asset.symbol}] Late layer ${i}: BUY ${lateSide} @ ${limitPrice}, ` +
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

          console.log(`[${asset.symbol}] LATE LAYER ${i} RESP:`, resp);
          state.sharesBoughtBySlug[slug] =
            (state.sharesBoughtBySlug[slug] || 0) + layerSize;
          addPosition(state, slug, lateSide, layerSize);
        } catch (err) {
          console.log(
            `[${asset.symbol}] Error placing late layer ${i}:`,
            err?.message || err
          );
        }
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
  const size = 100;
  const capCheck = canPlaceOrder(state, slug, best.side, size, asset.symbol);
  if (!capCheck.ok) {
    console.log(
      `[${asset.symbol}] Skipping EV buy; cap hit and not hedging. ` +
      `(reason=${capCheck.reason}, totalBefore=${capCheck.totalBefore}, totalAfter=${capCheck.totalAfter}, ` +
      `netBefore=${capCheck.netBefore}, netAfter=${capCheck.netAfter})`
    );
    return;
  }
  if (capCheck.reason === "hedge_beyond_cap") {
    console.log(
      `[${asset.symbol}] EV buy allowed beyond total cap because it reduces net exposure. ` +
      `(net ${capCheck.netBefore} -> ${capCheck.netAfter}, total ${capCheck.totalBefore} -> ${capCheck.totalAfter})`
    );
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
  const currentShares = state.sharesBoughtBySlug[slug] || 0;
  state.sharesBoughtBySlug[slug] = currentShares + size;
  addPosition(state, slug, best.side, size);
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

cron.schedule(`*/${interval} * * * * *`, async () => {
  await execAll().catch((err) => {
    console.error('Fatal error in main():', err);
    process.exit(1);
  });
});

cron.schedule("0 */20 * * * *", () => {
  console.log("\n[VOL] Reloading btc_sigma_1m.json...");
  sigmaConfig = loadSigmaConfig();
});
