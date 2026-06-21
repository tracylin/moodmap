-- 0010_accounts_devices.sql — Accounts Phase 3 identity layer (additive, inert until wired)

-- Two rows, closed set, no signup path. Emails baked in.
CREATE TABLE accounts (
  id    TEXT PRIMARY KEY,          -- 'wei' | 'cuixi' (canonical, matches canonAuthor())
  email TEXT NOT NULL,
  name  TEXT NOT NULL
);

-- One row per trusted device per account. The device token IS the session.
CREATE TABLE devices (
  token       TEXT PRIMARY KEY,    -- opaque random (crypto.randomUUID()); stored client-side, sent as header
  account_id  TEXT NOT NULL,
  label       TEXT,                -- 'Wei iPhone', 'Cuixi laptop'
  created_at  TEXT NOT NULL,       -- ISO
  last_seen   TEXT                 -- ISO, updated on validate (best-effort)
);
CREATE INDEX idx_devices_account ON devices(account_id);

-- Email OTP codes. Hashed, short TTL, single-use, rate-limited. Surrogate PK so
-- multiple in-flight codes per account are possible and individually addressable.
CREATE TABLE login_codes (
  id          TEXT PRIMARY KEY,    -- crypto.randomUUID()
  account_id  TEXT NOT NULL,
  code_hash   TEXT NOT NULL,       -- SHA-256 hex of the 6-digit code; plaintext NEVER stored/logged
  expires_at  TEXT NOT NULL,       -- ISO; TTL = 10 min
  consumed_at TEXT,                -- ISO when verified; NULL = unused
  attempts    INTEGER NOT NULL DEFAULT 0,  -- bad-verify counter; lock at 5
  created_at  TEXT NOT NULL        -- ISO; used for per-hour rate limit
);
CREATE INDEX idx_login_codes_account ON login_codes(account_id, created_at);

-- Seed the two accounts. INSERT OR IGNORE so re-applying the migration is a no-op
-- and so it never clobbers a manually-corrected email later.
INSERT OR IGNORE INTO accounts (id, email, name) VALUES
  ('wei',   'twiscold@gmail.com',      'Wei'),
  ('cuixi', 'cuixi.portal@gmail.com',  'Cuixi');
