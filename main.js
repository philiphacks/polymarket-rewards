import 'dotenv/config';
import clob from "@polymarket/clob-client";
import { Wallet } from "@ethersproject/wallet";
const { ApiKeyCreds, AssetType, ClobClient, OrderType, Side } = clob;

const HOST = 'https://clob.polymarket.com';
const CHAIN_ID = 137; // Polygon
const SIGNATURE_TYPE = 1; // 0 = EVM/browser; 1 = Magic/email
const FUNDER = '0xA69b1867a00c87928b5A1f6B1c2e9aC2246bD844';

const signer = new Wallet(process.env.PRIVATE_KEY);
const credsP = new ClobClient(HOST, CHAIN_ID, signer).createOrDeriveApiKey();

const getTokenIdsBySlugDataAPI = async (slug) => {
  const res = await fetch(`https://gamma-api.polymarket.com/markets/slug/${slug}`);
  const data = await res.json();
  const m = Array.isArray(data) ? data[0] : data;
  if (!m) throw new Error(`Market with slug "${slug}" not found (Data API)`);

  const tokenIds = JSON.parse(m['clobTokenIds']);
  return {
    rewardsMinSize: m['rewardsMinSize'],
    rewardsMaxSpread: m['rewardsMaxSpread'],
    tokenIds,
    bestBid: m['bestBid'],
    bestAsk: m['bestAsk'],
    liquidity: m['liquidity']
  }
};

(async () => {
  const creds = await credsP; // { key, secret, passphrase }

  console.log('Address:', await signer.getAddress());
  console.log("creds ok:", !!creds?.key);

  const client = new ClobClient(HOST, CHAIN_ID, signer, creds, SIGNATURE_TYPE, FUNDER);
  // const ba = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
  // console.log('USDC allowance:', ba);

  // list markets (public)
  // const markets = await client.getMarkets();      // paginated; accepts { nextCursor }
  // console.log('markets count:', markets?.count);

  const market = await getTokenIdsBySlugDataAPI('abnb-up-or-down-on-november-12-2025');
  console.log(market);
  // const up = "78722476470411300218485051719675002794304922006966104797522658950196378278235";
  // const down = "42937966633839436260142447621688442636839019389459517920685938229690764168281";

  // console.log("Up book:", await client.getOrderBook(up));
  // console.log("Down book:", await client.getOrderBook(down));
})();
