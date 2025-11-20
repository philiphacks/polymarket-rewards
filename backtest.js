// backtest.mjs
import fs from "fs";
import { decideTrade } from "./multi_crypto_updown_bot.mjs"; // if you later export it

const lines = fs.readFileSync("ticks-20251120.jsonl", "utf8").trim().split("\n");

for (const line of lines) {
  const snap = JSON.parse(line);
  const decision = decideTrade(snap);
  if (decision) {
    console.log(snap.symbol, snap.slug, decision);
  }
}
