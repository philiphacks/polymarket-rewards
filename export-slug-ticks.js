// export_slug_ticks.mjs
//
// Usage:
//   node export_slug_ticks.mjs <slug> [outFile]
//
// Example:
//   node export_slug_ticks.mjs btc-updown-15m-1763677800
//     -> writes ticks-btc-updown-15m-1763677800.jsonl
//
//   node export_slug_ticks.mjs btc-updown-15m-1763677800 myfile.jsonl

import fs from "fs";
import path from "path";
import readline from "readline";

// ---- CLI ARGS -------------------------------------------------

const targetSlug = process.argv[2];
if (!targetSlug) {
  console.error("Usage: node export_slug_ticks.mjs <slug> [outFile]");
  process.exit(1);
}

const outFile = process.argv[3] || `ticks-${targetSlug}.jsonl`;

// ---- DISCOVER INPUT FILES --------------------------------------

const cwd = process.cwd();

let files;
try {
  files = await fs.promises.readdir(cwd);
} catch (err) {
  console.error("Error reading current directory:", err);
  process.exit(1);
}

// Only keep files that look like ticks-YYYYMMDD.jsonl
const tickFiles = files.filter((f) => /^ticks-\d{8}\.jsonl$/.test(f));

if (tickFiles.length === 0) {
  console.error("No ticks-YYYYMMDD.jsonl files found in current directory.");
  process.exit(1);
}

console.log("Scanning files:", tickFiles.join(", "));
console.log("Target slug:", targetSlug);
console.log("Output file:", outFile);

// ---- OUTPUT STREAM ---------------------------------------------

const outStream = fs.createWriteStream(path.join(cwd, outFile), {
  flags: "w",
});

// ---- MAIN LOOP -------------------------------------------------

let totalMatched = 0;
let totalLines = 0;

for (const file of tickFiles) {
  const fullPath = path.join(cwd, file);
  console.log(`Reading ${fullPath} ...`);

  const rl = readline.createInterface({
    input: fs.createReadStream(fullPath),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    totalLines += 1;

    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch (err) {
      console.error(`Skipping invalid JSON line in ${file}:`, err.message);
      continue;
    }

    if (obj.slug === targetSlug) {
      outStream.write(trimmed + "\n");
      totalMatched += 1;
    }
  }
}

// ---- FINISH ----------------------------------------------------

outStream.end(() => {
  console.log(
    `Done. Total lines scanned: ${totalLines}. ` +
    `Matched for slug "${targetSlug}": ${totalMatched}.`
  );
  console.log(`Written to: ${outFile}`);
});
