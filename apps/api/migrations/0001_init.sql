-- AndroNode coordinator schema (D1 / SQLite). Money is integer USDC units (6 decimals). Times are unix ms.

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  address TEXT NOT NULL UNIQUE,            -- lowercase EVM address (login + payout wallet)
  is_admin INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',   -- active | suspended
  created_at INTEGER NOT NULL
);

CREATE TABLE auth_nonces (
  nonce TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  prefix TEXT NOT NULL,
  secret_hash TEXT NOT NULL UNIQUE,        -- sha256 of the key; plaintext is shown once
  label TEXT,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  key_id TEXT NOT NULL UNIQUE,             -- sha256 thumbprint of the public key
  public_key_jwk TEXT NOT NULL,
  form_factor TEXT NOT NULL,
  label TEXT,
  status TEXT NOT NULL DEFAULT 'probation', -- probation | active | suspended | revoked
  accepted_tasks INTEGER NOT NULL DEFAULT 0,
  rejected_tasks INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER
);
CREATE INDEX devices_account ON devices(account_id);

CREATE TABLE device_challenges (
  nonce TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

CREATE TABLE device_sessions (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(id),
  started_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  stopped_at INTEGER,
  limits_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX sessions_device ON device_sessions(device_id, ends_at);

CREATE TABLE quotes (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  profile_id TEXT NOT NULL,
  record_count INTEGER NOT NULL,
  per_record_units INTEGER NOT NULL,
  max_charge_units INTEGER NOT NULL,
  records_digest TEXT NOT NULL,
  records_key TEXT NOT NULL,               -- R2 key of the validated records
  deadline_hours INTEGER NOT NULL,
  quote_hash TEXT NOT NULL UNIQUE,         -- bytes32 committed on-chain
  order_id TEXT NOT NULL UNIQUE,           -- bytes32 orderIdFor(customer, quoteHash)
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE orders (
  id TEXT PRIMARY KEY,                     -- bytes32 on-chain order id
  quote_id TEXT NOT NULL UNIQUE REFERENCES quotes(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  state TEXT NOT NULL,                     -- QUOTED | FUNDED | RUNNING | COMPLETED | PARTIAL | CANCELLED | FAILED | CLOSED
  funding_mode TEXT NOT NULL,              -- chain | mock
  funding_tx TEXT,
  funded_units INTEGER NOT NULL DEFAULT 0,
  record_count INTEGER NOT NULL,
  accepted_records INTEGER NOT NULL DEFAULT 0,
  charged_units INTEGER NOT NULL DEFAULT 0,
  deadline_at INTEGER,
  hard_close_at INTEGER,
  created_at INTEGER NOT NULL,
  funded_at INTEGER,
  cancelled_at INTEGER,
  finished_at INTEGER
);
CREATE INDEX orders_account ON orders(account_id, created_at);
CREATE INDEX orders_state ON orders(state);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  idx INTEGER NOT NULL,
  record_start INTEGER NOT NULL,
  record_count INTEGER NOT NULL,
  charge_units INTEGER NOT NULL,
  reward_units INTEGER NOT NULL,
  input_digest TEXT NOT NULL,
  state TEXT NOT NULL,                     -- QUEUED | LEASED | SUBMITTED | VERIFYING | ACCEPTED | FAILED | CANCELLED
  attempts INTEGER NOT NULL DEFAULT 0,
  generation INTEGER NOT NULL DEFAULT 0,   -- fencing token, bumped on every lease
  current_lease_id TEXT,
  accepted_lease_id TEXT,
  updated_at INTEGER NOT NULL,
  UNIQUE (order_id, idx)
);
CREATE INDEX tasks_queue ON tasks(state, order_id, idx);

CREATE TABLE leases (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  device_id TEXT NOT NULL REFERENCES devices(id),
  generation INTEGER NOT NULL,
  reward_units INTEGER NOT NULL,
  nonce TEXT NOT NULL,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  state TEXT NOT NULL,                     -- LEASED | SUBMITTED | VERIFYING | ACCEPTED | REJECTED | EXPIRED | RETURNED
  output_digest TEXT,
  submitted_at INTEGER,
  reason TEXT,
  verified_at INTEGER
);
CREATE INDEX leases_device ON leases(device_id, state);
CREATE INDEX leases_state ON leases(state, expires_at);

CREATE TABLE receipts (
  id TEXT PRIMARY KEY,
  lease_id TEXT NOT NULL UNIQUE REFERENCES leases(id),
  task_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  decision TEXT NOT NULL,                  -- ACCEPTED | REJECTED
  reason TEXT,
  checks_json TEXT NOT NULL,
  stats_json TEXT,
  verifier TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX receipts_order ON receipts(order_id);

CREATE TABLE rewards (
  id TEXT PRIMARY KEY,
  lease_id TEXT NOT NULL UNIQUE REFERENCES leases(id),
  task_id TEXT NOT NULL UNIQUE,            -- one primary payment per logical task
  order_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  charge_units INTEGER NOT NULL,
  units INTEGER NOT NULL,
  state TEXT NOT NULL,                     -- PROVISIONAL | CLAIMABLE | HELD
  available_at INTEGER NOT NULL,           -- end of customer review window
  settlement_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX rewards_account ON rewards(account_id, state);
CREATE INDEX rewards_order ON rewards(order_id, state);

CREATE TABLE settlements (
  id TEXT PRIMARY KEY,                     -- bytes32 settlement id
  order_id TEXT NOT NULL,
  manifest_hash TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  charge_units INTEGER NOT NULL,
  contributor_units INTEGER NOT NULL,
  recipient_count INTEGER NOT NULL,
  status TEXT NOT NULL,                    -- proposed | confirmed | void
  tx_hash TEXT,
  created_at INTEGER NOT NULL,
  confirmed_at INTEGER
);

CREATE TABLE disputes (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,                      -- customer_output | contributor_appeal
  account_id TEXT NOT NULL,
  order_id TEXT,
  receipt_id TEXT,
  reason TEXT NOT NULL,
  status TEXT NOT NULL,                    -- open | upheld | rejected
  resolution TEXT,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);

-- Double-entry journal. Postings of one journal sum to zero.
CREATE TABLE journals (
  id TEXT PRIMARY KEY,
  event_key TEXT NOT NULL UNIQUE,          -- idempotency key for the economic event
  memo TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE postings (
  journal_id TEXT NOT NULL REFERENCES journals(id),
  account TEXT NOT NULL,                   -- e.g. escrow:<order>, payable:<account>, revenue:service
  units INTEGER NOT NULL
);
CREATE INDEX postings_account ON postings(account);

CREATE TABLE chain_events (
  id TEXT PRIMARY KEY,                     -- txHash:logIndex
  block_number INTEGER NOT NULL,
  event TEXT NOT NULL,
  data_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE chain_cursor (
  chain_id INTEGER PRIMARY KEY,
  last_block INTEGER NOT NULL
);

CREATE TABLE webhooks (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  url TEXT NOT NULL,
  secret TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  disabled_at INTEGER
);

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  detail_json TEXT,
  created_at INTEGER NOT NULL
);
