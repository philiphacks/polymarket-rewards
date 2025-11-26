import 'dotenv/config';
import clob from "@polymarket/clob-client";
const { AssetType, ClobClient, OrderType, Side } = clob;
import { Wallet } from "@ethersproject/wallet";

const GAMMA_URL = "https://gamma-api.polymarket.com/markets";
const HOST = 'https://clob.polymarket.com';
const CHAIN_ID = 137; // Polygon
const SIGNATURE_TYPE = 1; // 0 = EVM/browser; 1 = Magic/email
const FUNDER = '0xA69b1867a00c87928b5A1f6B1c2e9aC2246bD844';
const signer = new Wallet(process.env.PRIVATE_KEY);
const credsP = new ClobClient(HOST, CHAIN_ID, signer).createOrDeriveApiKey();

(async () => {
  const creds = await credsP; // { key, secret, passphrase }
  const client = new ClobClient(HOST, CHAIN_ID, signer, creds, SIGNATURE_TYPE, FUNDER);
  // let markets = (await client.getMarkets({ closed: false, active: true })).data || [];

  // const res = await fetch(`${GAMMA_URL}?closed=false&limit=1000`);
  const res = await fetch(`${GAMMA_URL}?closed=false&active=true&limit=1000`);
  const markets = await res.json();

  // Filter to “active & open & not archived & accepting orders”
  const liveMarkets = markets.filter(
    (m) => m.active && !m.closed && !m.archived && m.acceptingOrders
  );

  for (const m of liveMarkets) {
    const clobTokenIds = JSON.parse(m.clobTokenIds);

    const obYes = await client.getOrderBook(clobTokenIds[0]);
    const obNo  = await client.getOrderBook(clobTokenIds[1]);

    const bestYes = obYes.asks?.[0]?.price;
    const bestNo  = obNo.asks?.[0]?.price;
    if (bestYes == null || bestNo == null) continue;

    const yes = Number(bestYes);
    const no  = Number(bestNo);
    const sum = yes + no;

    if (sum < 1) {
      console.log(
        `${m.question} | YES: ${yes.toFixed(4)} NO: ${no.toFixed(4)} SUM: ${sum.toFixed(4)}`
      );
    }
  }
})().catch(console.error);
