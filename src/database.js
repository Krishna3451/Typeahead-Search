'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

/**
 * The primary store is a single embedded SQLite file - no Docker, no separate
 * server. Reads on the suggestion path never touch it (the in-memory prefix
 * index does); SQLite is the durable system-of-record that the batch writer
 * folds search counts into.
 */
function openDatabase(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL'); // SQLite's own WAL journal: fast commits, concurrent reads
  db.pragma('synchronous = NORMAL');
  db.pragma('temp_store = MEMORY');
  initSchema(db);
  return db;
}

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS queries (
      query      TEXT    PRIMARY KEY,
      count      INTEGER NOT NULL DEFAULT 0,   -- ranking weight: dataset count + accepted searches
      searches   INTEGER NOT NULL DEFAULT 0,   -- how many times submitted through /search
      updated_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_queries_count ON queries(count DESC);
  `);
}

// Bulk loader for dataset ingestion. Returns a function you call with an array
// of { query, count }; duplicates across files keep the larger seed count.
function makeBulkInserter(db) {
  const stmt = db.prepare(
    `INSERT INTO queries (query, count, searches, updated_at)
     VALUES (@query, @count, 0, @ts)
     ON CONFLICT(query) DO UPDATE SET count = MAX(count, excluded.count)`
  );
  const tx = db.transaction((rows, ts) => {
    for (const r of rows) stmt.run({ query: r.query, count: r.count, ts });
  });
  return (rows) => tx(rows, Date.now());
}

function loadTopQueries(db, limit) {
  return db.prepare(`SELECT query, count FROM queries ORDER BY count DESC LIMIT ?`).all(limit);
}

function countRows(db) {
  return db.prepare(`SELECT COUNT(*) AS n FROM queries`).get().n;
}

/**
 * Additive batch upsert run inside a single transaction. Counts ACCUMULATE
 * (count = count + delta) so two flushes touching the same query can never
 * clobber each other - the order they run in does not matter.
 */
function makeBatchUpserter(db) {
  const stmt = db.prepare(
    `INSERT INTO queries (query, count, searches, updated_at)
     VALUES (@query, @inc, @inc, @ts)
     ON CONFLICT(query) DO UPDATE SET
       count      = count + excluded.count,
       searches   = searches + excluded.searches,
       updated_at = excluded.updated_at`
  );
  const tx = db.transaction((entries, ts) => {
    for (const [query, inc] of entries) stmt.run({ query, inc, ts });
  });
  return (entries) => tx(entries, Date.now());
}

module.exports = {
  openDatabase,
  initSchema,
  makeBulkInserter,
  loadTopQueries,
  countRows,
  makeBatchUpserter,
};
