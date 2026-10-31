-- SDG CalQuest – baza (Cloudflare D1)
-- Za NOVU bazu:  npx wrangler d1 execute calquest --remote --file schema.sql
-- Postojeću bazu nadograđuješ datotekama iz mape migrations/ (svaku jednom).

CREATE TABLE IF NOT EXISTS users (
  email        TEXT PRIMARY KEY,          -- uvijek malim slovima
  name         TEXT NOT NULL DEFAULT '',
  active       INTEGER NOT NULL DEFAULT 1, -- 1 = ima pristup, 0 = isključen
  daily_limit  INTEGER,                    -- NULL = zadani limit iz postavki
  note         TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL,
  plan         TEXT NOT NULL DEFAULT 'free',
  trial_until  TEXT,
  paid_until   TEXT,
  member_claim INTEGER NOT NULL DEFAULT 0,
  self_registered INTEGER NOT NULL DEFAULT 0,
  stripe_customer TEXT,
  stripe_sub   TEXT,
  sub_status   TEXT,
  cancel_at_end INTEGER NOT NULL DEFAULT 0
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
  window_start INTEGER NOT NULL,
  ip           TEXT
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

-- šifrirane sigurnosne kopije (server ih ne može pročitati – ključ je samo kod korisnika)
CREATE TABLE IF NOT EXISTS backups (
  email        TEXT PRIMARY KEY,
  iv           TEXT NOT NULL,
  data         TEXT NOT NULL,            -- AES-GCM šifrat (base64)
  size         INTEGER NOT NULL,
  updated_at   TEXT NOT NULL,
  key_mail_at  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS payments (
  id            TEXT PRIMARY KEY,          -- Stripe ID računa (invoice)
  email         TEXT NOT NULL,
  name          TEXT NOT NULL DEFAULT '',
  amount_cents  INTEGER NOT NULL,
  currency      TEXT NOT NULL DEFAULT 'eur',
  plan          TEXT NOT NULL DEFAULT '',
  period_start  TEXT,
  period_end    TEXT,
  paid_at       TEXT NOT NULL,
  fiscalized    INTEGER NOT NULL DEFAULT 0,
  fiscalized_at TEXT,
  note          TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS payments_paid_at ON payments(paid_at);
CREATE INDEX IF NOT EXISTS users_customer ON users(stripe_customer);

INSERT OR IGNORE INTO settings (key, value) VALUES
  ('trial_days', '7'),
  ('price_member', '5'),
  ('price_external', '9');
