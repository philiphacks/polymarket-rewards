// fill_checker.js
import 'dotenv/config';
import clob from "@polymarket/clob-client";
const { ClobClient } = clob;
import { Wallet } from "@ethersproject/wallet";
import fs from "fs";
import readline from "readline";

// CONFIG
const ORDER_LOG_FILE = `orders-${new Date().toISOString().slice(0,10)}.jsonl`; // Defaults to today
const CLOB_HOST = "https://clob.polymarket.com";
const CHAIN_ID = 137;

async function checkFills() {
  console.log(`\n🕵️‍♀️ MONEYTRON FILL CHECKER`);
  console.log(`--------------------------`);

  // 1. Load Local Order History
  const localOrders = new Map(); // ID -> Order Data
  let totalVolumeRequested = 0;

  if (fs.existsSync(ORDER_LOG_FILE)) {
    const fileStream = fs.createReadStream(ORDER_LOG_FILE);
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    for await (const line of rl) {
      try {
        const ord = JSON.parse(line);
        if (ord.orderID) {
            localOrders.set(ord.orderID, { ...ord, filledSize: 0, filledValue: 0 });
            totalVolumeRequested += (ord.size * ord.price);
        }
      } catch (e) {}
    }
    console.log(`📄 Local Logs: Found ${localOrders.size} orders placed.`);
  } else {
    console.log(`❌ No order log file found: ${ORDER_LOG_FILE}`);
    return;
  }

  // 2. Connect to Polymarket
  console.log(`🌍 Fetching trade history from Polymarket...`);
  const signer = new Wallet(process.env.PRIVATE_KEY);
  const creds = await new ClobClient(CLOB_HOST, CHAIN_ID, signer).createOrDeriveApiKey();
  const client = new ClobClient(CLOB_HOST, CHAIN_ID, signer, creds);

  // Fetch last 500 trades (Adjust limit if you trade HEAVY volume)
  // Note: Polymarket might paginate. This is a simple implementation.
  const trades = await client.getTrades({ limit: 500 }); 
  
  console.log(`✅ Retrieved last ${trades.length} trades from exchange.`);

  // 3. Match Reality vs. Intention
  let matches = 0;
  let totalVolumeFilled = 0;
  let totalSlippage = 0;

  for (const trade of trades) {
    // The API returns 'orderID'. Check if we tracked it.
    if (localOrders.has(trade.orderID)) {
      const attempt = localOrders.get(trade.orderID);
      
      const fillSize = parseFloat(trade.size);
      const fillPrice = parseFloat(trade.price);
      
      attempt.filledSize += fillSize;
      attempt.filledValue += (fillSize * fillPrice);
      
      // Calculate Slippage (Did we pay more than we wanted?)
      // For buys: Fill Price - Limit Price
      // For sells: Limit Price - Fill Price
      // Since Moneytron is buy-only mostly:
      const slip = (fillPrice - attempt.price) * fillSize;
      totalSlippage += slip;

      matches++;
      totalVolumeFilled += (fillSize * fillPrice);
    }
  }

  // 4. Analysis Report
  console.log(`\n📊 EXECUTION REPORT`);
  console.log(`===================`);
  
  const fillRateVol = (totalVolumeFilled / totalVolumeRequested) * 100;
  
  // Count fully filled vs ghosted
  let fullyFilled = 0;
  let partial = 0;
  let ghosts = 0;

  localOrders.forEach(ord => {
    if (ord.filledSize >= ord.size) fullyFilled++;
    else if (ord.filledSize > 0) partial++;
    else ghosts++;
  });

  console.log(`Requested Vol:  $${totalVolumeRequested.toFixed(2)}`);
  console.log(`Filled Vol:     $${totalVolumeFilled.toFixed(2)}`);
  console.log(`Fill Rate ($):  ${fillRateVol.toFixed(1)}%`);
  console.log(`Avg Slippage:   $${(totalSlippage / matches || 0).toFixed(4)} per fill`);
  console.log(`-------------------`);
  console.log(`Orders Placed:  ${localOrders.size}`);
  console.log(`Fully Filled:   ${fullyFilled} ✅`);
  console.log(`Partially:      ${partial} ⚠️`);
  console.log(`Ghosts (0%):    ${ghosts} 👻`);
  
  // 5. Diagnose Ghosts
  if (ghosts > 0) {
    console.log(`\n👻 GHOST DIAGNOSIS (Last 3 Misses)`);
    let count = 0;
    localOrders.forEach((ord) => {
      if (ord.filledSize === 0 && count < 3) {
        console.log(`[${new Date(ord.ts).toISOString().split('T')[1]}] ${ord.symbol} ${ord.side} @ ${ord.price} (Size ${ord.size}) - UNTOUCHED`);
        count++;
      }
    });
    console.log(`\n💡 TIP: High 'Ghost' count means your latency is too high or your logic reacts to liquidity that is already gone.`);
  }
}

checkFills();
