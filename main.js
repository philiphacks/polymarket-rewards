// *****************************
// **     Important links     **
// *****************************
// https://x.com/gusik4ever/status/1983550815622013218?t=ASwzvq-uRxr3M2_-xGq9GQ&s=09
// https://github.com/Polymarket/clob-client/blob/main/examples/cancelOrder.ts
// https://docs.polymarket.com/developers/CLOB/clients

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

const getTokenIdsBySlugDataAPI = async (slug) => {
  const res = await fetch(`https://gamma-api.polymarket.com/markets/slug/${slug}`);
  const data = await res.json();
  const m = Array.isArray(data) ? data[0] : data;
  if (!m) throw new Error(`Market with slug "${slug}" not found (Data API)`);

  const tokenIds = JSON.parse(m['clobTokenIds']);
  const midpoint = parseFloat(Number(m['bestBid'] + m['bestAsk']) / 2.0);
  const buyUpPrice = roundHalfUp((midpoint - Number(Math.floor(m['rewardsMaxSpread']) / 100.0)), 3);
  const sellUpPrice = roundHalfUp((midpoint + Number(Math.floor(m['rewardsMaxSpread']) / 100.0)), 3);
  return {
    rewardsMinSize: m['rewardsMinSize'],
    rewardsMaxSpread: m['rewardsMaxSpread'],
    tokenIds,
    bestBid: m['bestBid'],
    bestAsk: m['bestAsk'],
    midpoint: roundHalfUp(midpoint),
    buyUpPrice: roundHalfUp(buyUpPrice),
    buyDownPrice: roundHalfUp(1 - sellUpPrice)
  }
};

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
    { id: 'abnb-up-or-down-on-november-12-2025', size: 250 },
    { id: 'will-the-government-shutdown-end-november-12-365', size: 250 },
    { id: '', size: 250 }
  ];

  // For each slug, fetch the market
  await asyncForEach(slugs, async (slugObject) => {
    const market = await getTokenIdsBySlugDataAPI(slugObject['id']);
    console.log(market);
    const up = market['tokenIds'][0];
    const down = market['tokenIds'][1];

    // console.log("Up book:", await client.getOrderBook(up));
    // console.log("Down book:", await client.getOrderBook(down));

    // cancel open orders
    const n = await cancelAllOpenOrders(client, { tokenID: market['tokenIds'] });
    console.log(n);

    // place bid
    const size = slugObject['size'];
    const priceUp = market['buyUpPrice'];
    const priceDown = market['buyDownPrice'];
    // const gtc = await client.createAndPostOrder(
    //   { tokenID: market.tokenIds[0], price, side: Side.BUY, size },
    //   { tickSize: '0.01', negRisk: false },
    //   OrderType.GTC
    // );
    // console.log('GTC result:', gtc);
    const expiresAt = Math.floor(Date.now()/1000) + 10*60; // 10 minutes
    const cost = BigInt(Math.round(priceUp*1e6)) * BigInt(size);
    if (BigInt(ba.balance) < cost) throw new Error('Insufficient USDC on funder');

    let gtd = await client.createAndPostOrder(
      { tokenID: market.tokenIds[0], price: priceUp, side: Side.BUY, size: parseInt(size / priceUp, 10), expiration: String(expiresAt) },
      { tickSize: '0.01', negRisk: false },
      OrderType.GTD
    );
    console.log('GTD result:', gtd);

    await sleep(1000);

    gtd = await client.createAndPostOrder(
      { tokenID: market.tokenIds[1], price: priceDown, side: Side.BUY, size: parseInt(size / priceDown, 10), expiration: String(expiresAt) },
      { tickSize: '0.01', negRisk: false },
      OrderType.GTD
    );
    console.log('GTD result:', gtd);
  });
};

// every 10 mins: '*/10 * * * *'
cron.schedule('0/10 * * * *', () => {
  console.log('10 mins passed... running poly bids');
  exec();
});
