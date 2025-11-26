import fs from 'fs';
import readline from 'readline';
import path from 'path';

// ================= CONFIG =================
const TICK_FILES_DIR = './files';  // Directory with ticks-*.jsonl files
const ORDER_FILES_DIR = './files'; // Directory with orders-*.jsonl files
const OUTPUT_BASE_DIR = './files';

const WINNERS_DIR = path.join(OUTPUT_BASE_DIR, 'winners');
const LOSERS_DIR = path.join(OUTPUT_BASE_DIR, 'losers');

// ==========================================

async function loadJsonl(filepath) {
  const data = [];
  
  if (!fs.existsSync(filepath)) {
    return data;
  }
  
  const fileStream = fs.createReadStream(filepath);
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });
  
  for await (const line of rl) {
    try {
      data.push(JSON.parse(line));
    } catch (e) {
      // Skip invalid lines
    }
  }
  
  return data;
}

function extractSlugFromTick(tick) {
  // Ticks have a 'slug' field directly
  return tick.slug || null;
}

function extractSlugFromOrder(order, timestamp) {
  // Orders don't have slug, so we need to derive it from:
  // - symbol (e.g., "BTC")
  // - timestamp (e.g., 1764129600245)
  
  // Convert timestamp to 15-min interval start
  const intervalMs = 15 * 60 * 1000;
  const intervalStart = Math.floor(timestamp / intervalMs) * intervalMs;
  const intervalStartSec = Math.floor(intervalStart / 1000);
  
  const symbol = order.symbol.toLowerCase();
  return `${symbol}-updown-15m-${intervalStartSec}`;
}

function calculatePnL(ticks, orders) {
  if (ticks.length === 0 || orders.length === 0) {
    return null;
  }
  
  // Get start and final prices
  const firstTick = ticks[0];
  const lastTick = ticks[ticks.length - 1];
  
  const startPrice = firstTick.startPrice;
  const finalPrice = lastTick.currentPrice;
  const winner = finalPrice > startPrice ? 'UP' : 'DOWN';
  
  // Calculate position
  let upShares = 0, downShares = 0;
  let upCost = 0, downCost = 0;
  
  orders.forEach(order => {
    if (order.side === 'UP') {
      upShares += order.size;
      upCost += order.size * order.price;
    } else {
      downShares += order.size;
      downCost += order.size * order.price;
    }
  });
  
  const totalCost = upCost + downCost;
  const payout = winner === 'UP' ? upShares : downShares;
  const pnl = payout - totalCost;
  
  return {
    startPrice,
    finalPrice,
    priceChange: ((finalPrice - startPrice) / startPrice * 100).toFixed(3),
    winner,
    upShares,
    downShares,
    upCost,
    downCost,
    totalCost,
    payout,
    pnl,
    isWinner: pnl > 0
  };
}

async function processAllTrades() {
  console.log('🚀 Starting trade classification...\n');
  
  // Create output directories
  if (!fs.existsSync(WINNERS_DIR)) {
    fs.mkdirSync(WINNERS_DIR, { recursive: true });
    console.log(`✅ Created directory: ${WINNERS_DIR}`);
  }
  
  if (!fs.existsSync(LOSERS_DIR)) {
    fs.mkdirSync(LOSERS_DIR, { recursive: true });
    console.log(`✅ Created directory: ${LOSERS_DIR}`);
  }
  
  // Find all tick and order files
  const allFiles = fs.readdirSync(TICK_FILES_DIR);
  const tickFiles = allFiles.filter(f => f.startsWith('ticks-') && f.endsWith('.jsonl'));
  const orderFiles = allFiles.filter(f => f.startsWith('orders-') && f.endsWith('.jsonl'));
  
  console.log(`\n📊 Found ${tickFiles.length} tick files and ${orderFiles.length} order files`);
  
  // Load ALL ticks and group by slug
  console.log('\n⏳ Loading all ticks...');
  const ticksBySlug = {};
  
  for (const tickFile of tickFiles) {
    const tickPath = path.join(TICK_FILES_DIR, tickFile);
    const ticks = await loadJsonl(tickPath);
    
    console.log(`   ${tickFile}: ${ticks.length} ticks`);
    
    ticks.forEach(tick => {
      const slug = extractSlugFromTick(tick);
      if (slug) {
        if (!ticksBySlug[slug]) {
          ticksBySlug[slug] = [];
        }
        ticksBySlug[slug].push(tick);
      }
    });
  }
  
  // Load ALL orders and group by derived slug
  console.log('\n⏳ Loading all orders...');
  const ordersBySlug = {};
  
  for (const orderFile of orderFiles) {
    const orderPath = path.join(ORDER_FILES_DIR, orderFile);
    const orders = await loadJsonl(orderPath);
    
    console.log(`   ${orderFile}: ${orders.length} orders`);
    
    orders.forEach(order => {
      const slug = extractSlugFromOrder(order, order.ts);
      if (slug) {
        if (!ordersBySlug[slug]) {
          ordersBySlug[slug] = [];
        }
        ordersBySlug[slug].push(order);
      }
    });
  }
  
  // Get all unique slugs (union of ticks and orders)
  const allSlugs = new Set([
    ...Object.keys(ticksBySlug),
    ...Object.keys(ordersBySlug)
  ]);
  
  const slugs = Array.from(allSlugs).sort();
  console.log(`\n📋 Processing ${slugs.length} unique markets...\n`);
  
  let processedCount = 0;
  let winnersCount = 0;
  let losersCount = 0;
  let skippedCount = 0;
  
  const summary = {
    winners: [],
    losers: [],
    skipped: []
  };
  
  for (const slug of slugs) {
    try {
      const ticks = ticksBySlug[slug] || [];
      const orders = ordersBySlug[slug] || [];
      
      if (ticks.length === 0) {
        console.log(`⚠️  ${slug}: No ticks found, skipping`);
        skippedCount++;
        summary.skipped.push({ slug, reason: 'No ticks' });
        continue;
      }
      
      if (orders.length === 0) {
        console.log(`⚠️  ${slug}: No orders placed, skipping`);
        skippedCount++;
        summary.skipped.push({ slug, reason: 'No orders' });
        continue;
      }
      
      // Sort by timestamp
      ticks.sort((a, b) => a.ts - b.ts);
      orders.sort((a, b) => a.ts - b.ts);
      
      // Calculate P&L
      const analysis = calculatePnL(ticks, orders);
      
      if (!analysis) {
        console.log(`⚠️  ${slug}: Could not calculate P&L, skipping`);
        skippedCount++;
        summary.skipped.push({ slug, reason: 'P&L calculation failed' });
        continue;
      }
      
      // Create output object
      const output = {
        slug,
        symbol: ticks[0].symbol,
        timestamp: ticks[0].ts,
        startTime: new Date(ticks[0].ts).toISOString(),
        endTime: new Date(ticks[ticks.length - 1].ts).toISOString(),
        analysis: {
          startPrice: analysis.startPrice,
          finalPrice: analysis.finalPrice,
          priceChange: analysis.priceChange,
          winner: analysis.winner,
          position: {
            upShares: analysis.upShares,
            downShares: analysis.downShares,
            upCost: analysis.upCost,
            downCost: analysis.downCost,
            totalCost: analysis.totalCost,
            payout: analysis.payout
          },
          pnl: analysis.pnl,
          isWinner: analysis.isWinner
        },
        stats: {
          tickCount: ticks.length,
          orderCount: orders.length,
          orderTypes: {}
        },
        ticks,
        orders
      };
      
      // Count order types
      orders.forEach(o => {
        output.stats.orderTypes[o.type] = (output.stats.orderTypes[o.type] || 0) + 1;
      });
      
      // Determine output directory and filename
      const outputDir = analysis.isWinner ? WINNERS_DIR : LOSERS_DIR;
      const outputFile = path.join(outputDir, `${slug}.json`);
      
      // Write to file
      fs.writeFileSync(outputFile, JSON.stringify(output, null, 2));
      
      // Update counters
      processedCount++;
      if (analysis.isWinner) {
        winnersCount++;
        summary.winners.push({
          slug,
          pnl: analysis.pnl,
          winner: analysis.winner,
          priceChange: analysis.priceChange
        });
        console.log(`✅ ${slug}: WIN  | PnL: $${analysis.pnl.toFixed(2)} | ${analysis.winner} (${analysis.priceChange}%)`);
      } else {
        losersCount++;
        summary.losers.push({
          slug,
          pnl: analysis.pnl,
          winner: analysis.winner,
          priceChange: analysis.priceChange
        });
        console.log(`❌ ${slug}: LOSS | PnL: $${analysis.pnl.toFixed(2)} | ${analysis.winner} (${analysis.priceChange}%)`);
      }
      
    } catch (error) {
      console.error(`❌ ${slug}: Error - ${error.message}`);
      skippedCount++;
      summary.skipped.push({ slug, reason: error.message });
    }
  }
  
  // Print summary
  console.log('\n' + '='.repeat(80));
  console.log('📊 FINAL SUMMARY');
  console.log('='.repeat(80));
  console.log(`Total markets found: ${slugs.length}`);
  console.log(`Processed: ${processedCount}`);
  console.log(`  Winners: ${winnersCount} (${(winnersCount / processedCount * 100).toFixed(1)}%)`);
  console.log(`  Losers:  ${losersCount} (${(losersCount / processedCount * 100).toFixed(1)}%)`);
  console.log(`Skipped: ${skippedCount}`);
  
  // Calculate totals
  const totalWinPnL = summary.winners.reduce((sum, w) => sum + w.pnl, 0);
  const totalLossPnL = summary.losers.reduce((sum, l) => sum + l.pnl, 0);
  const netPnL = totalWinPnL + totalLossPnL;
  
  console.log(`\n💰 P&L BREAKDOWN:`);
  console.log(`Total wins:   $${totalWinPnL.toFixed(2)}`);
  console.log(`Total losses: $${totalLossPnL.toFixed(2)}`);
  console.log(`Net P&L:      $${netPnL.toFixed(2)}`);
  
  console.log(`\n📁 OUTPUT DIRECTORIES:`);
  console.log(`Winners: ${WINNERS_DIR}`);
  console.log(`Losers:  ${LOSERS_DIR}`);
  
  if (skippedCount > 0) {
    console.log(`\n⚠️  SKIPPED MARKETS:`);
    summary.skipped.forEach(s => {
      console.log(`  ${s.slug}: ${s.reason}`);
    });
  }
  
  // Write summary file
  const summaryFile = path.join(OUTPUT_BASE_DIR, 'trade_summary.json');
  fs.writeFileSync(summaryFile, JSON.stringify({
    generatedAt: new Date().toISOString(),
    totals: {
      marketsFound: slugs.length,
      processed: processedCount,
      winners: winnersCount,
      losers: losersCount,
      skipped: skippedCount,
      winRate: (winnersCount / processedCount * 100).toFixed(1) + '%'
    },
    pnl: {
      totalWins: totalWinPnL,
      totalLosses: totalLossPnL,
      net: netPnL
    },
    winners: summary.winners.sort((a, b) => b.pnl - a.pnl), // Sort by PnL desc
    losers: summary.losers.sort((a, b) => a.pnl - b.pnl),   // Sort by PnL asc (worst first)
    skipped: summary.skipped
  }, null, 2));
  
  console.log(`\n📄 Summary written to: ${summaryFile}`);
  console.log('\n✅ Classification complete!');
}

// Run
processAllTrades().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
