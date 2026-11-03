-- Workers Free support: blob storage without R2, atomic replay guard without KV writes,
-- and a claim table so periodic jobs can run from requests when no cron slot is available.
CREATE TABLE IF NOT EXISTS blobs (
  key TEXT NOT NULL,
  part INTEGER NOT NULL,
  parts INTEGER NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (key, part)
);
CREATE TABLE IF NOT EXISTS device_replay (
  sig_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS device_replay_expires ON device_replay(expires_at);
CREATE TABLE IF NOT EXISTS job_runs (
  name TEXT PRIMARY KEY,
  last_at INTEGER NOT NULL
);
INSERT OR IGNORE INTO job_runs (name, last_at) VALUES ('periodic', 0);
