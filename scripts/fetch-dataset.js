'use strict';

/**
 * Downloads the open Norvig word-frequency n-gram files (derived from the Google
 * Web Trillion Word Corpus). Each line is "<term>\t<count>", which is exactly
 * the <query, count> shape this project needs.
 *
 *   count_1w.txt - ~333k single words
 *   count_2w.txt - ~286k two-word phrases (realistic multi-word queries)
 *
 * Usage: node scripts/fetch-dataset.js [--force]
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const config = require('../src/config');

const SOURCES = [
  { url: 'https://norvig.com/ngrams/count_1w.txt', file: 'count_1w.txt', desc: 'unigrams (single words)' },
  { url: 'https://norvig.com/ngrams/count_2w.txt', file: 'count_2w.txt', desc: 'bigrams (two-word phrases)' },
];

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const tmp = dest + '.part';
    const out = fs.createWriteStream(tmp);
    const req = https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        out.close();
        fs.unlink(tmp, () => {});
        return download(res.headers.location, dest).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        out.close();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const total = Number(res.headers['content-length'] || 0);
      let got = 0;
      let lastPct = -1;
      res.on('data', (c) => {
        got += c.length;
        if (total) {
          const pct = Math.floor((got / total) * 100);
          if (pct !== lastPct && pct % 20 === 0) {
            process.stdout.write(`    ${path.basename(dest)}: ${pct}%\r`);
            lastPct = pct;
          }
        }
      });
      res.pipe(out);
      out.on('finish', () => out.close(() => {
        fs.renameSync(tmp, dest);
        resolve();
      }));
    });
    req.on('error', (e) => {
      out.close();
      fs.unlink(tmp, () => {});
      reject(e);
    });
    req.setTimeout(120000, () => req.destroy(new Error('timeout after 120s')));
  });
}

(async () => {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const force = process.argv.includes('--force');
  for (const s of SOURCES) {
    const dest = path.join(config.dataDir, s.file);
    if (fs.existsSync(dest) && !force) {
      console.log(`  = ${s.file} already present (use --force to re-download)`);
      continue;
    }
    console.log(`  v downloading ${s.desc} -> ${s.file}`);
    try {
      await download(s.url, dest);
      console.log(`  + ${s.file} done (${(fs.statSync(dest).size / 1e6).toFixed(1)} MB)`);
    } catch (e) {
      console.error(`  ! failed to download ${s.url}: ${e.message}`);
      console.error('    You can still load a synthetic dataset: npm run load-data -- --synthetic 150000');
      process.exitCode = 1;
    }
  }
})();
