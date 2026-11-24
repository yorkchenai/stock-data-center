CREATE TABLE analysis_snapshots (
  id TEXT PRIMARY KEY,
  cache_key TEXT NOT NULL,
  asset_type TEXT NOT NULL CHECK(asset_type IN ('stock','fund')),
  symbol TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  purge_at INTEGER NOT NULL,
  chunks INTEGER NOT NULL CHECK(chunks BETWEEN 1 AND 12)
);
CREATE INDEX analysis_snapshot_lookup ON analysis_snapshots(cache_key, expires_at, created_at);
CREATE INDEX analysis_snapshot_retention ON analysis_snapshots(purge_at);
CREATE TABLE analysis_snapshot_chunks (
  id TEXT NOT NULL REFERENCES analysis_snapshots(id) ON DELETE CASCADE,
  part INTEGER NOT NULL,
  body BLOB NOT NULL,
  PRIMARY KEY(id, part)
);
CREATE TABLE analysis_snapshot_leases (
  cache_key TEXT PRIMARY KEY,
  token TEXT NOT NULL,
  failure TEXT,
  expires_at INTEGER NOT NULL
);
CREATE INDEX analysis_snapshot_lease_retention ON analysis_snapshot_leases(expires_at);
CREATE TABLE analysis_snapshot_limits (
  slot TEXT PRIMARY KEY,
  minute INTEGER NOT NULL,
  calls INTEGER NOT NULL
);
