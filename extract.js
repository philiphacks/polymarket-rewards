import fs from "fs";
import readline from "readline";

// ================= CONFIG =================
const SLUGS_TO_EXTRACT = [
  "eth-updown-15m-1764222300"
];

const ORDER_FILES = [
  "files/orders-2025-11-22.jsonl",
  "files/orders-2025-11-23.jsonl",
  "files/orders-2025-11-24.jsonl",
  "files/orders-2025-11-25.jsonl",
  "files/orders-2025-11-26.jsonl",
  "files/orders-2025-11-27.jsonl",
];

const TICK_FILES = [
  "files/ticks-20251120.jsonl",
  "files/ticks-20251121.jsonl",
  "files/ticks-20251122.jsonl",
  "files/ticks-20251123.jsonl",
  "files/ticks-20251124.jsonl",
  "files/ticks-20251125.jsonl",
  "files/ticks-20251126.jsonl",
  "files/ticks-20251127.jsonl",
];

// ==========================================

// Parse slug to get start and end timestamps
function parseSlug(slug) {
  // Format: "btc-updown-15m-1764028800"
  const parts = slug.split('-');
  const startUnix = parseInt(parts[parts.length - 1]);
  
  if (isNaN(startUnix)) {
    throw new Error(`Invalid slug format: ${slug}`);
  }
  
  const startMs = startUnix * 1000;
  const endMs = startMs + (15 * 60 * 1000); // 15 minutes later
  
  return { startMs, endMs };
}

// Read file line by line and filter
async function extractFromFile(filePath, filterFn) {
  const results = [];
  
  if (!fs.existsSync(filePath)) {
    console.log(`⚠️  File not found: ${filePath}`);
    return results;
  }
  
  const fileStream = fs.createReadStream(filePath);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity
  });
  
  for await (const line of rl) {
    try {
      const obj = JSON.parse(line);
      if (filterFn(obj)) {
        results.push(obj);
      }
    } catch (e) {
      // Skip invalid JSON lines
    }
  }
  
  return results;
}

// Extract orders for a slug
async function extractOrdersForSlug(slug, orderFiles) {
  const { startMs, endMs } = parseSlug(slug);
  const symbol = slug.split('-')[0].toUpperCase();
  
  console.log(`\n📋 Extracting orders for ${slug}...`);
  console.log(`   Symbol: ${symbol}`);
  console.log(`   Time range: ${new Date(startMs).toISOString()} to ${new Date(endMs).toISOString()}`);
  
  let allOrders = [];
  
  for (const file of orderFiles) {
    const orders = await extractFromFile(file, (order) => {
      // Match symbol and timestamp range
      return order.symbol === symbol && 
             order.ts >= startMs && 
             order.ts < endMs;
    });
    
    allOrders = allOrders.concat(orders);
  }
  
  // Sort by timestamp
  allOrders.sort((a, b) => a.ts - b.ts);
  
  console.log(`   ✅ Found ${allOrders.length} orders`);
  
  return allOrders;
}

// Extract ticks for a slug
async function extractTicksForSlug(slug, tickFiles) {
  console.log(`\n📊 Extracting ticks for ${slug}...`);
  
  let allTicks = [];
  
  for (const file of tickFiles) {
    const ticks = await extractFromFile(file, (tick) => {
      return tick.slug === slug;
    });
    
    allTicks = allTicks.concat(ticks);
  }
  
  // Sort by timestamp
  allTicks.sort((a, b) => a.ts - b.ts);
  
  console.log(`   ✅ Found ${allTicks.length} ticks`);
  
  return allTicks;
}

// Write results to file
function writeToFile(filename, data) {
  const lines = data.map(obj => JSON.stringify(obj)).join('\n');
  fs.writeFileSync(filename, lines + '\n');
  console.log(`   💾 Wrote to ${filename}`);
}

// Main execution
async function main() {
  console.log("🚀 Starting extraction...\n");
  console.log(`Slugs to extract: ${SLUGS_TO_EXTRACT.length}`);
  console.log(`Order files: ${ORDER_FILES.length}`);
  console.log(`Tick files: ${TICK_FILES.length}`);
  
  for (const slug of SLUGS_TO_EXTRACT) {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`Processing: ${slug}`);
    console.log("=".repeat(60));
    
    try {
      // Extract orders
      const orders = await extractOrdersForSlug(slug, ORDER_FILES);
      const orderFilename = `orders-${slug}.jsonl`;
      writeToFile(orderFilename, orders);
      
      // Extract ticks
      const ticks = await extractTicksForSlug(slug, TICK_FILES);
      const tickFilename = `ticks-${slug}.jsonl`;
      writeToFile(tickFilename, ticks);
      
      // Summary
      console.log(`\n   📈 Summary for ${slug}:`);
      console.log(`      Orders: ${orders.length}`);
      console.log(`      Ticks: ${ticks.length}`);
      
      if (orders.length > 0) {
        const firstOrder = new Date(orders[0].ts).toISOString();
        const lastOrder = new Date(orders[orders.length - 1].ts).toISOString();
        console.log(`      First order: ${firstOrder}`);
        console.log(`      Last order: ${lastOrder}`);
        
        // Order breakdown by type
        const byType = {};
        orders.forEach(o => {
          byType[o.type] = (byType[o.type] || 0) + 1;
        });
        console.log(`      Order types:`, byType);
        
        // Position summary
        const upShares = orders.filter(o => o.side === 'UP').reduce((sum, o) => sum + o.size, 0);
        const downShares = orders.filter(o => o.side === 'DOWN').reduce((sum, o) => sum + o.size, 0);
        console.log(`      Position: ${upShares} UP, ${downShares} DOWN`);
      }
      
      if (ticks.length > 0) {
        const firstTick = ticks[0];
        const lastTick = ticks[ticks.length - 1];
        console.log(`      Start price: $${firstTick.startPrice.toFixed(2)}`);
        console.log(`      Final price: $${lastTick.currentPrice.toFixed(2)}`);
        console.log(`      Winner: ${lastTick.currentPrice > firstTick.startPrice ? 'UP' : 'DOWN'}`);
      }
      
    } catch (error) {
      console.error(`\n   ❌ Error processing ${slug}:`, error.message);
    }
  }
  
  console.log(`\n${"=".repeat(60)}`);
  console.log("✅ Extraction complete!");
  console.log("=".repeat(60));
}

// Run
main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
