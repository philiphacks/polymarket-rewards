// *****************************
// **     Important links     **
// *****************************
// https://x.com/gusik4ever/status/1983550815622013218?t=ASwzvq-uRxr3M2_-xGq9GQ&s=09
// https://github.com/Polymarket/clob-client/blob/main/examples/cancelOrder.ts
// https://docs.polymarket.com/developers/CLOB/clients

// *****************************
// **          TODO           **
// *****************************
// 1. Hedging
// Once have hedging
// 2. Add aggressive flag to do aggressive orders or not (i.e. closer to midpoint, now everything goes conservative)
// 3. Scan Polymarket for YES/NO best asks <$1 (inefficient markets)
// 4. Automate incentivised market & slug finding in getSlugsForMarket

import 'dotenv/config';
import cron from "node-cron";
import clob from "@polymarket/clob-client";
import { Wallet } from "@ethersproject/wallet";
const { AssetType, ClobClient, OrderType, Side } = clob;

const HOST = 'https://clob.polymarket.com';
const CHAIN_ID = 137; // Polygon
const SIGNATURE_TYPE = 1; // 0 = EVM/browser; 1 = Magic/email
const FUNDER = '0xA69b1867a00c87928b5A1f6B1c2e9aC2246bD844';
// const FUNDER = '0xf308b87303FF2F76c4c101927054b1FbAD182E5E';
const TICK = 0.01;
const snap = (p, t=TICK) => Math.round(p / t) * t; // nearest tick
const toUnits = (x) => BigInt(Math.round(x * 1e6)); // USDC 6dp

const signer = new Wallet(process.env.PRIVATE_KEY);
const credsP = new ClobClient(HOST, CHAIN_ID, signer).createOrDeriveApiKey();

async function asyncForEach(array, callback) {
  for (let index = 0; index < array.length; index++) {
    await callback(array[index], index, array);
  }
}

function roundHalfUp(x, decimals = 2) {
  const factor = 10 ** decimals;
  const n = x * factor;
  // half-up: push .5 up for positives and more negative for negatives
  const i = n >= 0 ? Math.floor(n + 0.5) : Math.ceil(n - 0.5);
  return i / factor;
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
};

async function cancelAllOpenOrders(client, opts = {}) {
  const { tokenID, side, batchSize = 5, dryRun = false } = opts;

  const open = await client.getOpenOrders(); // [{ id, tokenId, side, ... }]
  const tokenSet = tokenID
    ? new Set([].concat(tokenID).map(String))
    : null;

  const sideNorm =
    side === undefined
      ? undefined
      : typeof side === 'string'
        ? side.toUpperCase() // "BUY" | "SELL"
        : side;               // numeric enum from clob.Side

  const matches = open.filter(o => {
    const tokenOk = tokenSet ? tokenSet.has(String(o.asset_id)) : true;
    const sideOk =
      sideNorm === undefined
        ? true
        : typeof sideNorm === 'string'
          ? (o.side === sideNorm || String(o.side).toUpperCase() === sideNorm)
          : o.side === sideNorm;
    return tokenOk && sideOk;
  });

  if (dryRun) {
    return { totalOpen: open.length, matched: matches.length, canceled: 0, failed: [] };
  }

  const failed = [];
  for (let i = 0; i < matches.length; i += batchSize) {
    const batch = matches.slice(i, i + batchSize);
    const results = await Promise.allSettled(
      batch.map(o => {
        const maker = FUNDER || o.maker_address; // prefer explicit FUNDER if provided
        const payload = { id: o.id, maker };
        // console.log('cancel ->', payload);
        return client.cancelOrder({ orderID: o.id });
      })
    );
    console.log('RES:', results[0]);
    results.forEach((r, idx) => {
      if (r.status === 'rejected') failed.push(batch[idx].id);
    });
    // tiny backoff between batches; adjust if you hit 429s
    if (i + batchSize < matches.length) await new Promise(r => setTimeout(r, 150));
  }

  return {
    totalOpen: open.length,
    matched: matches.length,
    canceled: matches.length - failed.length,
    failed,
  };
}

const getSlugsForMarket = async (eventSlug) => {
  const res = await fetch(`https://gamma-api.polymarket.com/events/slug/${eventSlug}`);
  const data = await res.json();
  const links = data.markets.map(m => ({
    title: m.question || m.ticker || m.slug,
    slug: m.slug,
    url: `https://polymarket.com/market/${m.slug}`,
  }));
} 

const getTokenIdsBySlugDataAPI = async (client, slug) => {
  const res = await fetch(`https://gamma-api.polymarket.com/markets/slug/${slug}`);
  const data = await res.json();
  const m = Array.isArray(data) ? data[0] : data;
  if (!m) throw new Error(`Market with slug "${slug}" not found (Data API)`);

  const tokenIds = JSON.parse(m['clobTokenIds']);
  const midpoint = parseFloat(Number(m['bestBid'] + m['bestAsk']) / 2.0);
  const buyUpPrice = roundHalfUp((midpoint - Number(Math.floor(m['rewardsMaxSpread']) / 100.0)), 3);
  const sellUpPrice = roundHalfUp((midpoint + Number(Math.floor(m['rewardsMaxSpread']) / 100.0)), 3);
  console.log(m);
  const midpoints = await client.getMidpoints([{ token_id: tokenIds[0] }, { token_id: tokenIds[1] }]);
  console.log(midpoints);

  return {
    rewardsMinSize: m['rewardsMinSize'],
    rewardsMaxSpread: m['rewardsMaxSpread'],
    tokenIds,
    bestBid: m['bestBid'],
    bestAsk: m['bestAsk'],
    midpoint: roundHalfUp(midpoint),
    buyUpPrice: roundHalfUp(buyUpPrice),
    buyDownPrice: roundHalfUp(1 - sellUpPrice),
    negRisk: !!m['negRisk'],
    tickSize: m['orderPriceMinTickSize']
  }
};

async function showOrderbook(client, { marketId, slug, outcome = 'Up', depth = 5 }) {
  const m = marketId
    ? (await client.getMarkets()).find((x) => x.id === marketId)
    : (await client.getMarkets()).find((x) => x.slug === slug || x.ticker === slug);

  if (!m) throw new Error('Market not found');

  const book = await client.getOrderBook({ marketId: m.id, outcome });
  console.log(`Orderbook: ${m.ticker || m.slug} / ${outcome}`);
  console.table({
    bestAsk: book.asks?.[0] ? `${book.asks[0].price}¢ x ${book.asks[0].size}` : '—',
    bestBid: book.bids?.[0] ? `${book.bids[0].price}¢ x ${book.bids[0].size}` : '—',
  });
  console.log('Top asks:');
  for (const l of (book.asks || []).slice(0, depth)) {
    console.log(`  ask ${l.price}¢  x ${l.size}`);
  }
  console.log('Top bids:');
  for (const l of (book.bids || []).slice(0, depth)) {
    console.log(`  bid ${l.price}¢  x ${l.size}`);
  }
}

const exec = async () => {
  const creds = await credsP; // { key, secret, passphrase }
  console.log('Address:', await signer.getAddress());
  const client = new ClobClient(HOST, CHAIN_ID, signer, creds, SIGNATURE_TYPE, FUNDER);
  const ba = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
  console.log('USDC allowance:', ba);

  // list markets (public)
  // const markets = await client.getMarkets();      // paginated; accepts { nextCursor }
  // console.log('markets count:', markets?.count);

  const slugs = [
    { id: 'abnb-up-or-down-on-november-13-2025', budget: 500 },
    { id: 'rklb-up-or-down-on-november-13-2025', budget: 500 },
    { id: 'open-up-or-down-on-november-13-2025', budget: 500 },
    { id: 'pltr-up-or-down-on-november-13-2025', budget: 500 },
    { id: 'nya-up-or-down-on-november-13-2025', budget: 500 },
    { id: 'nflx-up-or-down-on-november-13-2025', budget: 500 },
    { id: 'rut-up-or-down-on-november-13-2025', budget: 500 },
    { id: 'nvda-up-or-down-on-november-13-2025', budget: 500 },
    { id: 'hsi-up-or-down-on-november-13-2025', budget: 500 },
    { id: 'tsla-up-or-down-on-november-13-2025', budget: 500 },
    { id: 'dax-up-or-down-on-november-13-2025', budget: 500 },
    { id: 'meta-up-or-down-on-november-13-2025', budget: 500 },
    { id: 'ukx-up-or-down-on-november-13-2025', budget: 500 },
    { id: 'googl-up-or-down-on-november-13-2025', budget: 500 },
    { id: 'dji-up-or-down-on-november-13-2025', budget: 500 },
    { id: 'ndx-up-or-down-on-november-13-2025', budget: 500 },
    { id: 'amzn-up-or-down-on-november-13-2025', budget: 500 },
    { id: 'nik-up-or-down-on-november-13-2025', budget: 500 },
    { id: 'msft-up-or-down-on-november-13-2025', budget: 500 },
    { id: 'aapl-up-or-down-on-november-13-2025', budget: 500 },
    { id: 'spx-up-or-down-on-november-13-2025', budget: 500 },
    { id: 'will-jos-antonio-kast-win-the-chilean-presidential-election', budget: 500 },

    { id: 'will-gemini-3pt0-be-released-by-november-22-442', budget: 1000 },
    { id: 'will-gemini-3pt0-be-released-by-november-30-643-555', budget: 1000 },

    // { id: 'paradex-fdv-above-750m-one-day-after-launch', budget: 250 },
    // { id: 'paradex-fdv-above-1pt5b-one-day-after-launch', budget: 250 },
    // { id: 'paradex-fdv-above-3b-one-day-after-launch', budget: 250 },
    // { id: 'paradex-fdv-above-5b-one-day-after-launch', budget: 250 },

    // { id: 'fed-decreases-interest-rates-by-25-bps-after-december-2025-meeting', budget: 250 },

    // { id: 'will-uniswap-labs-win-2025-uniswap-cup', budget: 250 },
    // { id: 'will-uniswap-foundation-win-2025-uniswap-cup', budget: 250 },
    // { id: 'will-1inch-win-2025-uniswap-cup', budget: 250 },
    // { id: 'will-aave-win-2025-uniswap-cup', budget: 250 },
    // { id: 'will-across-win-2025-uniswap-cup', budget: 250 },
    // { id: 'will-anchorage-win-2025-uniswap-cup', budget: 250 },
    // { id: 'will-angstrom-win-2025-uniswap-cup', budget: 250 },
    // { id: 'will-arbitrum-win-2025-uniswap-cup', budget: 250 },
    // { id: 'will-atrium-academy-win-2025-uniswap-cup', budget: 250 },
    // { id: 'will-avalanche-win-2025-uniswap-cup', budget: 250 },
    // { id: 'will-aztec-win-2025-uniswap-cup', budget: 250 },
    // { id: 'will-bungee-win-2025-uniswap-cup', budget: 250 },
    // { id: 'will-crecimiento-win-2025-uniswap-cup', budget: 250 },
    // { id: 'will-eigencloud-win-2025-uniswap-cup', budget: 250 },
    // { id: 'will-espacio-cripto-win-2025-uniswap-cup', budget: 250 },
    // { id: 'will-layerzero-win-2025-uniswap-cup', budget: 250 },
    // { id: 'will-morpho-win-2025-uniswap-cup', budget: 250 },
    // { id: 'will-openzeppelin-win-2025-uniswap-cup', budget: 250 },
    // { id: 'will-privy-win-2025-uniswap-cup', budget: 250 },
    // { id: 'will-walletconnect-win-2025-uniswap-cup', budget: 250 },
    // { id: 'will-wormhole-win-2025-uniswap-cup', budget: 250 },
    // { id: 'will-zora-win-2025-uniswap-cup', budget: 250 },
  ];

  // For each slug, fetch the market
  for (const { id: slug, budget } of slugs) {
    await sleep(1000);
    const market = await getTokenIdsBySlugDataAPI(client, slug);
    console.log(market);
    const upId = market['tokenIds'][0];
    const downId = market['tokenIds'][1];
    const upBook = await client.getOrderBook(upId);
    const downBook = await client.getOrderBook(downId);

    // cancel open orders
    const n = await cancelAllOpenOrders(client, { tokenID: market['tokenIds'] });
    console.log(n);

    // place bid
    const size = budget;
    const priceUp = market['buyUpPrice'];
    const priceDown = market['buyDownPrice'];
    // const gtc = await client.createAndPostOrder(
    //   { tokenID: market.tokenIds[0], price, side: Side.BUY, size },
    //   { tickSize: '0.01', negRisk: false },
    //   OrderType.GTC
    // );
    // console.log('GTC result:', gtc);
    // const expiresAt = Math.floor(Date.now()/1000) + 10*60; // 10 minutes
    // const cost = BigInt(Math.round(priceUp*1e6)) * BigInt(size);
    // if (BigInt(ba.balance) < cost) throw new Error('Insufficient USDC on funder');

    // let gtd = await client.createAndPostOrder(
    //   { tokenID: market.tokenIds[0], price: priceUp, side: Side.BUY, size: parseInt(size / priceUp, 10), expiration: String(expiresAt) },
    //   { tickSize: '0.01', negRisk: false },
    //   OrderType.GTD
    // );
    // console.log('GTD result:', gtd);

    // await sleep(1000);

    // gtd = await client.createAndPostOrder(
    //   { tokenID: market.tokenIds[1], price: priceDown, side: Side.BUY, size: parseInt(size / priceDown, 10), expiration: String(expiresAt) },
    //   { tickSize: '0.01', negRisk: false },
    //   OrderType.GTD
    // );
    // console.log('GTD result:', gtd);

    {
      const raw = market.buyUpPrice;
      const price = snap(raw, TICK);           // ensure on tick
      const shares = Math.floor(budget / price);  // shares integer
      console.log('SHARES:', budget, raw, price, shares);
      if (shares >= 5 && raw > 0) {                       // respect orderMinSize
        const cost = toUnits(price) * BigInt(shares);
        if (BigInt(ba.balance) >= cost) {
          const expiresAt = Math.floor(Date.now()/1000) + 12*60*60; // 12 hrs
          const resp = await client.createAndPostOrder(
            { tokenID: upId, price, side: Side.BUY, size: shares, expiration: String(expiresAt) },
            { tickSize: market['tickSize'], negRisk: market['negRisk'] },
            OrderType.GTD
          );
          console.log('UP GTD:', resp);
        } else {
          console.log('UP skipped: insufficient USDC');
        }
      } else {
        console.log('UP skipped: size < min (5)');
      }
    }

    await sleep(500);

    {
      const raw = market.buyDownPrice;
      const price = snap(raw, TICK);
      const shares = Math.floor(budget / price);
      if (shares >= 5 && raw > 0) {
        const cost = toUnits(price) * BigInt(shares);
        const ba2 = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL }); // refresh
        if (BigInt(ba2.balance) >= cost) {
          const expiresAt = Math.floor(Date.now()/1000) + 12*60*60;
          const resp = await client.createAndPostOrder(
            { tokenID: downId, price, side: Side.BUY, size: shares, expiration: String(expiresAt) },
            { tickSize: market['tickSize'], negRisk: market['negRisk'] },
            OrderType.GTD
          );
          console.log('DOWN GTD:', resp);
        } else {
          console.log('DOWN skipped: insufficient USDC');
        }
      } else {
        console.log('DOWN skipped: size < min (5)');
      }
    }
  };
};

async function computeInventory(client) {
  const addr = await client.signer.getAddress();
  const fills = await client.getFills({ address: addr, limit: 1000 });

  // paginate if needed (clob-client usually handles paging; fallback to before=<ts> loop if exposed)
  const key = (f) => `${f.market_id}|${f.outcome}`;
  const pos = new Map();
  for (const f of fills) {
    const k = key(f);
    const r = pos.get(k) || { market_id: f.market_id, outcome: f.outcome, buy: 0, sell: 0, buyCost: 0 };
    if (f.side === 'buy') { r.buy += +f.size; r.buyCost += (+f.size) * (+f.price); }
    else if (f.side === 'sell') { r.sell += +f.size; }
    pos.set(k, r);
  }

  const out = [];
  for (const [, r] of pos) {
    const net = r.buy - r.sell;
    if (Math.abs(net) < 1e-8) continue;
    out.push({
      market_id: r.market_id,
      outcome: r.outcome,
      net_shares: +net.toFixed(2),
      avg_cost_cents: r.buy ? +(r.buyCost / r.buy).toFixed(2) : 0,
    });
  }
  return out;
}

const calculateAndHedgeInventory = async () => {
  console.log('hedging...');
  // const creds = await credsP; // { key, secret, passphrase }
  // const client = new ClobClient(HOST, CHAIN_ID, signer, creds, SIGNATURE_TYPE, FUNDER);

  // // computeInventory(client);
  // const market = await getTokenIdsBySlugDataAPI(client, 'abnb-up-or-down-on-november-13-2025?tid=1762976765251');

  // Example to hedge
  const sharesBought = 54.0;
  const priceBought = 0.47;
  const bestAsk = 0.53;
  const amountToHedge = (sharesBought * priceBought) / (1.0 - bestAsk);
  console.log(`Spent $${sharesBought * priceBought}. Need to buy`, Number(amountToHedge).toFixed(0), `shares for a total of $${Number(amountToHedge * bestAsk).toFixed(0)}`);
};

// exec();
calculateAndHedgeInventory();

const runCron = false;
if (runCron) {
  // every 12 hours: '0 */12 * * *'
  // every 10 mins: '*/10 * * * *'
  cron.schedule('0 */12 * * *', () => {
    console.log('running poly bids');
    exec();
  });
}
