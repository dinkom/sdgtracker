-- SDG CalQuest – migracija 002: naplata i samoregistracija
-- Pokreni JEDNOM na postojećoj bazi:
--   npx wrangler d1 execute calquest --remote --file migrations/002_naplata.sql
-- Postojeći korisnici dobivaju plan "free" (besplatno) – promijeni im ga u adminu po potrebi.

ALTER TABLE users ADD COLUMN plan TEXT NOT NULL DEFAULT 'free';      -- trial | member | external | free
ALTER TABLE users ADD COLUMN trial_until TEXT;                       -- ISO datum kraja probnog razdoblja
ALTER TABLE users ADD COLUMN paid_until TEXT;                        -- ISO datum do kad je plaćeno
ALTER TABLE users ADD COLUMN member_claim INTEGER NOT NULL DEFAULT 0;-- korisnik kaže da je član SDG Gyma
ALTER TABLE users ADD COLUMN self_registered INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN stripe_customer TEXT;
ALTER TABLE users ADD COLUMN stripe_sub TEXT;
ALTER TABLE users ADD COLUMN sub_status TEXT;                        -- active | trialing | past_due | canceled | …
ALTER TABLE users ADD COLUMN cancel_at_end INTEGER NOT NULL DEFAULT 0;

ALTER TABLE codes ADD COLUMN ip TEXT;

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
