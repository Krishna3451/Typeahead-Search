'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Append-only durability log for the write buffer. Every accepted search is
 * recorded here BEFORE it is aggregated, so if the process dies between flushes
 * the un-flushed searches can be replayed on the next startup. Flushing is fully
 * synchronous (a submit cannot interleave a flush), so a successful flush can
 * simply truncate the log back to empty.
 *
 * Note: this app-level journal is independent of SQLite's own WAL journal mode;
 * this one recovers searches that were buffered but not yet handed to SQLite.
 */
class Journal {
  constructor(filePath, enabled) {
    this.enabled = enabled;
    this.path = filePath;
    this.fd = null;
    if (enabled) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      this.fd = fs.openSync(filePath, 'a'); // append; existing content is preserved for recovery
    }
  }

  append(query) {
    if (this.fd !== null) fs.writeSync(this.fd, query + '\n');
  }

  // Truncate by path (close -> truncate -> reopen): ftruncate on an append-mode
  // fd is unreliable on Windows. Only runs on flush, so the cost is negligible.
  checkpoint() {
    if (this.fd === null) return;
    fs.closeSync(this.fd);
    fs.truncateSync(this.path, 0);
    this.fd = fs.openSync(this.path, 'a');
  }

  readPending() {
    if (!this.enabled || !fs.existsSync(this.path)) return [];
    return fs.readFileSync(this.path, 'utf8').split('\n').filter(Boolean);
  }

  close() {
    if (this.fd !== null) {
      try {
        fs.closeSync(this.fd);
      } catch (_) {
        /* ignore */
      }
      this.fd = null;
    }
  }
}

/**
 * Write-behind buffer. Instead of one DB write per search, searches are
 * aggregated in memory (repeated queries collapse into a single row) and flushed
 * either every flushIntervalMs or once flushBatchSize distinct queries have
 * piled up. In-memory structures (prefix index, recency window) are updated
 * immediately on submit so suggestions stay fresh; the DB just lags behind by at
 * most one flush window.
 */
class BatchWriter {
  constructor(deps, opts) {
    this.upsert = deps.upsert; // (entries: [ [query, inc] ]) => void
    this.index = deps.index;
    this.recency = deps.recency;
    this.cache = deps.cache;
    this.stats = deps.stats;
    this.journal = new Journal(opts.journalPath, opts.journalEnabled);
    this.flushIntervalMs = opts.flushIntervalMs;
    this.flushBatchSize = opts.flushBatchSize;
    this.buffer = new Map(); // query -> pending increment
    this.touched = new Set(); // queries whose cached prefixes need invalidation
    this.flushing = false;
    this.timer = null;
    this.recovered = 0;
  }

  start() {
    this._recover();
    this.timer = setInterval(() => this.flush('interval'), this.flushIntervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  // One accepted search: journal -> buffer -> immediate in-memory updates.
  submit(query) {
    this.journal.append(query);
    this.buffer.set(query, (this.buffer.get(query) || 0) + 1);
    this.stats.inc('searchesAccepted');
    const { isNew } = this.index.bump(query, 1);
    if (isNew) this.stats.inc('newQueries');
    this.recency.record(query, 1);
    this.touched.add(query);
    if (this.buffer.size >= this.flushBatchSize) this.flush('size');
  }

  flush(reason = 'manual') {
    if (this.flushing || this.buffer.size === 0) return { written: 0, reason };
    this.flushing = true;
    const batch = this.buffer;
    this.buffer = new Map();
    const touched = this.touched;
    this.touched = new Set();
    try {
      this.upsert([...batch.entries()]);
      this.stats.inc('dbWrites', batch.size);
      this.stats.inc('flushBatches');
      const invalidated = this.cache.invalidateForQueries(touched);
      this.journal.checkpoint();
      return { written: batch.size, invalidated, reason };
    } catch (err) {
      // nothing is lost: fold the batch back in and let the next tick retry
      for (const [q, c] of batch) this.buffer.set(q, (this.buffer.get(q) || 0) + c);
      for (const q of touched) this.touched.add(q);
      this.stats.lastFlushError = err.message;
      return { written: 0, error: err.message, reason };
    } finally {
      this.flushing = false;
    }
  }

  // Replay searches that were journaled but never flushed (crash recovery).
  _recover() {
    const pending = this.journal.readPending();
    if (pending.length === 0) return;
    for (const q of pending) {
      this.buffer.set(q, (this.buffer.get(q) || 0) + 1);
      this.index.bump(q, 1);
      this.recency.record(q, 1);
      this.touched.add(q);
    }
    this.stats.inc('searchesAccepted', pending.length);
    this.recovered = pending.length;
    this.flush('recovery');
    console.log(`[batch] recovered ${pending.length} un-flushed searches from the journal`);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.flush('shutdown');
    this.journal.close();
  }

  get pending() {
    return this.buffer.size;
  }
}

module.exports = { BatchWriter, Journal };
