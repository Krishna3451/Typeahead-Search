'use strict';

/**
 * Ingests the dataset into the SQLite primary store.
 *
 *   node scripts/load-dataset.js                 # load count_1w + count_2w
 *   node scripts/load-dataset.js --reset         # wipe table first
 *   node scripts/load-dataset.js --unigrams-only # skip the bigram file
 *   node scripts/load-dataset.js --limit 200000  # keep only the top-N by count
 *   node scripts/load-dataset.js --min-count 50  # drop rare terms
 *   node scripts/load-dataset.js --synthetic 150000   # offline fallback, no files needed
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const config = require('../src/config');
const { openDatabase, makeBulkInserter, countRows } = require('../src/database');

function parseArgs(argv) {
  const a = { limit: 0, minCount: 1, synthetic: 0, reset: false, unigramsOnly: false };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--limit') a.limit = parseInt(argv[++i], 10) || 0;
    else if (k === '--min-count') a.minCount = parseInt(argv[++i], 10) || 1;
    else if (k === '--synthetic') a.synthetic = parseInt(argv[++i], 10) || 150000;
    else if (k === '--reset') a.reset = true;
    else if (k === '--unigrams-only') a.unigramsOnly = true;
  }
  return a;
}

const clean = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();
const isOk = (q) => q.length >= 1 && q.length <= 60 && /[a-z0-9]/.test(q);

async function readNgramFile(file, minCount, onRow) {
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  let n = 0;
  for await (const line of rl) {
    if (!line) continue;
    const tab = line.lastIndexOf('\t');
    if (tab === -1) continue;
    const q = clean(line.slice(0, tab));
    const c = parseInt(line.slice(tab + 1), 10);
    if (!Number.isFinite(c) || c < minCount || !isOk(q)) continue;
    onRow(q, c);
    n++;
  }
  return n;
}

// Deterministic, Zipf-distributed synthetic queries (offline fallback).
function syntheticRows(target) {
  const heads = ['how to', 'best', 'cheap', 'buy', 'free', 'download', 'what is', 'why is', 'top', 'review of'];
  const subjects = [
    'laptop', 'phone', 'coffee maker', 'running shoes', 'headphones', 'pizza', 'guitar', 'camera',
    'backpack', 'keyboard', 'monitor', 'standing desk', 'novel', 'pasta recipe', 'flight', 'hotel',
    'online course', 'tutorial', 'jacket', 'smart watch', 'air fryer', 'mattress', 'bicycle', 'tent',
  ];
  const mods = ['', ' 2026', ' online', ' near me', ' for beginners', ' under 500', ' reviews', ' deals', ' india'];
  const rows = new Map();
  let rank = 1;
  while (rows.size < target && rank < target * 6) {
    const q = clean(`${heads[(rank * 7) % heads.length]} ${subjects[(rank * 13) % subjects.length]}${mods[(rank * 5) % mods.length]}`);
    if (!rows.has(q)) rows.set(q, Math.max(1, Math.floor(10_000_000 / Math.pow(rank, 1.07))));
    rank++;
  }
  let i = 0;
  while (rows.size < target) {
    rows.set(`sample query number ${i}`, Math.max(1, Math.floor(5000 / (1 + i))));
    i++;
  }
  return [...rows.entries()].map(([query, count]) => ({ query, count }));
}

(async () => {
  const args = parseArgs(process.argv);
  const db = openDatabase(config.dbPath);
  if (args.reset) {
    db.exec('DELETE FROM queries');
    console.log('[load] cleared existing rows');
  }
  const insert = makeBulkInserter(db);

  const t0 = Date.now();
  let buf = [];
  let totalParsed = 0;
  const flush = () => {
    if (buf.length) {
      insert(buf);
      buf = [];
    }
  };
  const onRow = (q, c) => {
    buf.push({ query: q, count: c });
    totalParsed++;
    if (buf.length >= 50000) {
      flush();
      process.stdout.write(`    parsed ${totalParsed}\r`);
    }
  };

  if (args.synthetic > 0) {
    console.log(`[load] generating ${args.synthetic} synthetic queries...`);
    for (const r of syntheticRows(args.synthetic)) onRow(r.query, r.count);
  } else {
    const uni = path.join(config.dataDir, 'count_1w.txt');
    const bi = path.join(config.dataDir, 'count_2w.txt');
    if (!fs.existsSync(uni)) {
      console.error(`[load] ${uni} not found. Run "npm run fetch-data" first, or use --synthetic <N>.`);
      process.exit(1);
    }
    console.log('[load] reading unigrams (count_1w.txt)...');
    await readNgramFile(uni, args.minCount, onRow);
    if (!args.unigramsOnly && fs.existsSync(bi)) {
      console.log('\n[load] reading bigrams (count_2w.txt)...');
      await readNgramFile(bi, args.minCount, onRow);
    }
  }
  flush();

  if (args.limit > 0) {
    console.log(`\n[load] trimming to the top ${args.limit} by count...`);
    db.prepare(`DELETE FROM queries WHERE query NOT IN (SELECT query FROM queries ORDER BY count DESC LIMIT ?)`).run(args.limit);
  }

  const rows = countRows(db);
  console.log(`\n[load] done: parsed ${totalParsed} lines, stored ${rows} unique queries in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`[load] primary store: ${config.dbPath}`);
  db.close();
})();
