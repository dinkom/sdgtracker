-- SDG CalQuest – baza (Cloudflare D1)
-- Pokreni jednom:  npx wrangler d1 execute calquest --remote --file schema.sql

CREATE TABLE IF NOT EXISTS users (
  email        TEXT PRIMARY KEY,          -- uvijek malim slovima
  name         TEXT NOT NULL DEFAULT '',
  active       INTEGER NOT NULL DEFAULT 1, -- 1 = ima pristup, 0 = isključen
  daily_limit  INTEGER,                    -- NULL = zadani limit iz postavki
  note         TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL
);

-- jedan uređaj po korisniku; čuva se samo sažetak (hash) tajnog ključa uređaja
CREATE TABLE IF NOT EXISTS devices (
  token_hash   TEXT PRIMARY KEY,
  email        TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  last_seen    TEXT NOT NULL,
  user_agent   TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS devices_email ON devices(email);

-- kodovi za prijavu (vrijede 10 minuta, najviše 5 pokušaja)
CREATE TABLE IF NOT EXISTS codes (
  email        TEXT PRIMARY KEY,
  code_hash    TEXT NOT NULL,
  expires_at   INTEGER NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 0,
  sent_at      INTEGER NOT NULL,
  sent_count   INTEGER NOT NULL DEFAULT 1,
  window_start INTEGER NOT NULL
);

-- potrošnja po korisniku i danu
CREATE TABLE IF NOT EXISTS usage (
  email          TEXT NOT NULL,
  day            TEXT NOT NULL,            -- YYYY-MM-DD (Europe/Zagreb)
  requests       INTEGER NOT NULL DEFAULT 0,
  photos         INTEGER NOT NULL DEFAULT 0,
  input_tokens   INTEGER NOT NULL DEFAULT 0,
  output_tokens  INTEGER NOT NULL DEFAULT 0,
  cost_usd       REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (email, day)
);

-- postavke koje mijenjaš u admin sučelju
CREATE TABLE IF NOT EXISTS settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('text_model',    'claude-haiku-5-5'),
  ('photo_model',   'claude-sonnet-5-5'),
  ('daily_limit',   '40');
