#!/usr/bin/env node
/**
 * Quick Daily Stats - Moneytron v2.4.1
 * Fast daily performance summary
 * 
 * Usage: node daily_stats.js [--date 2024-11-27]
 */

import fs from 'fs';

const args = process.argv.slice(2);
let targetDate = new Date().toISOString().slice(0, 10); // Today

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--date' && args[i + 1]) {
    targetDate = args[i + 1];
  }
}

const orderFile = `./files/orders-${targetDate}.jsonl`;
const tickFile = `./files/ticks-${targetDate.replace(/-/g, '')}.jsonl`;

console.log(`\n${'='.repeat(60)}`);
console.log(`DAILY STATS - ${targetDate}`);
console.log('='.repeat(60));

// Check if files directory exists
if (!fs.existsSync('./files')) {
  console.log(`\n❌ Directory ./files/ not found`);
  console.log('Make sure your log files are in ./files/');
  process.exit(1);
}

// Load orders
if (!fs.existsSync(orderFile)) {
  console.log(`\n❌ No order file found: ${orderFile}`);
  process.exit(1);
}

const orders = fs.readFileSync(orderFile, 'utf-8')
  .trim().split('\n')
  .filter(l => l.length > 0)
  .map(l => JSON.parse(l));

const entries = orders.filter(o => o.type !== 'EXIT');
const exits = orders.filter(o => o.type === 'EXIT');

console.log(`\n📊 ORDER SUMMARY`);
console.log(`Total Orders: ${orders.length}`);
console.log(`  Entries: ${entries.length}`);
console.log(`  Exits: ${exits.length}`);

// By type
const byType = {};
entries.forEach(o => {
  byType[o.type] = (byType[o.type] || 0) + 1;
});

console.log(`\nOrder Types:`);
Object.entries(byType).forEach(([type, count]) => {
  console.log(`  ${type}: ${count}`);
});

// By session
const usTrades = entries.filter(o => o.session === 'US').length;
const nonUSTrades = entries.filter(o => o.session === 'NON-US').length;

console.log(`\nSessions:`);
console.log(`  US Hours: ${usTrades} (${(usTrades/entries.length*100).toFixed(0)}%)`);
console.log(`  Non-US Hours: ${nonUSTrades} (${(nonUSTrades/entries.length*100).toFixed(0)}%)`);

// By symbol
const bySymbol = {};
entries.forEach(o => {
  bySymbol[o.symbol] = (bySymbol[o.symbol] || 0) + 1;
});

console.log(`\nBy Asset:`);
Object.entries(bySymbol).forEach(([sym, count]) => {
  console.log(`  ${sym}: ${count}`);
});

// Total size
const totalSize = entries.reduce((sum, o) => sum + o.size, 0);
const avgSize = totalSize / entries.length;

console.log(`\nPosition Sizing:`);
console.log(`  Total Shares: ${totalSize}`);
console.log(`  Avg Size: ${avgSize.toFixed(0)}`);

// Exits
if (exits.length > 0) {
  console.log(`\n🚨 EXIT SUMMARY`);
  console.log(`Total Exits: ${exits.length}`);
  
  const reasons = {};
  exits.forEach(e => {
    reasons[e.reason] = (reasons[e.reason] || 0) + 1;
  });
  
  console.log(`\nExit Reasons:`);
  Object.entries(reasons).forEach(([reason, count]) => {
    console.log(`  ${reason}: ${count}`);
  });
  
  const totalRecovery = exits.reduce((sum, e) => sum + (e.expectedRecovery || 0), 0);
  const avgRecovery = totalRecovery / exits.length;
  
  console.log(`\nExpected Recovery:`);
  console.log(`  Total: $${totalRecovery.toFixed(2)}`);
  console.log(`  Average: $${avgRecovery.toFixed(2)}`);
  
  // Urgency
  const emergency = exits.filter(e => e.urgency === 'emergency').length;
  const normal = exits.filter(e => e.urgency === 'normal').length;
  
  console.log(`\nUrgency:`);
  console.log(`  Emergency: ${emergency}`);
  console.log(`  Normal: ${normal}`);
}

// Load ticks for price action
if (fs.existsSync(tickFile)) {
  const ticks = fs.readFileSync(tickFile, 'utf-8')
    .trim().split('\n')
    .filter(l => l.length > 0)
    .map(l => JSON.parse(l));
  
  console.log(`\n📈 PRICE ACTION`);
  console.log(`Total Ticks: ${ticks.length}`);
  
  // Group by symbol
  const ticksBySymbol = {};
  ticks.forEach(t => {
    if (!ticksBySymbol[t.symbol]) ticksBySymbol[t.symbol] = [];
    ticksBySymbol[t.symbol].push(t);
  });
  
  console.log(`\nVolatility (avg σ per minute):`);
  Object.entries(ticksBySymbol).forEach(([sym, sysTicks]) => {
    const avgSigma = sysTicks.reduce((sum, t) => sum + t.sigmaPerMin, 0) / sysTicks.length;
    console.log(`  ${sym}: $${avgSigma.toFixed(4)}`);
  });
  
  // Max z-scores
  console.log(`\nMax Signal Strength (|z|):`);
  Object.entries(ticksBySymbol).forEach(([sym, sysTicks]) => {
    const maxZ = Math.max(...sysTicks.map(t => Math.abs(t.z)));
    console.log(`  ${sym}: ${maxZ.toFixed(2)}σ`);
  });
}

console.log(`\n${'='.repeat(60)}`);
console.log(`Run 'node analyze_trading_metrics.js' for full analysis`);
console.log('='.repeat(60));
console.log('');
