-- ============================================================
-- Suitor schema. Idempotent: safe to run on every deploy.
-- No seed data: Discover only ever shows real registered users.
-- ============================================================

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name          TEXT NOT NULL,
  gender        TEXT NOT NULL CHECK (gender IN ('lady', 'gent')),
  age           INT  NOT NULL CHECK (age >= 18),
  avatar_color  TEXT NOT NULL,
  bio           TEXT NOT NULL DEFAULT '',
  token_balance INT  NOT NULL DEFAULT 0 CHECK (token_balance >= 0),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Canonical ordering (user_a_id < user_b_id) guarantees one row per pair.
CREATE TABLE IF NOT EXISTS conversations (
  id         TEXT PRIMARY KEY,
  user_a_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_b_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_a_id, user_b_id),
  CHECK (user_a_id < user_b_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body            TEXT NOT NULL,
  tokens_charged  INT  NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_messages_conv_created
  ON messages (conversation_id, created_at);

CREATE TABLE IF NOT EXISTS conversation_reads (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, user_id)
);

CREATE TABLE IF NOT EXISTS purchases (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pack_id           TEXT NOT NULL,
  tokens            INT NOT NULL,
  amount_usd        NUMERIC(10,2) NOT NULL,
  paypal_order_id   TEXT UNIQUE NOT NULL,
  paypal_capture_id TEXT,
  status            TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'completed', 'failed')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS reports (
  id          TEXT PRIMARY KEY,
  reporter_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reported_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason      TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS blocks (
  blocker_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id),
  CHECK (blocker_id <> blocked_id)
);

-- Lady invite codes: ladies can only sign up with a valid, unrevoked,
-- unexhausted invite code minted via scripts/gen-invite.js.
CREATE TABLE IF NOT EXISTS invite_codes (
  id         TEXT PRIMARY KEY,
  code       TEXT UNIQUE NOT NULL,
  label      TEXT NOT NULL DEFAULT '',
  max_uses   INT  NOT NULL DEFAULT 1 CHECK (max_uses >= 1),
  uses       INT  NOT NULL DEFAULT 0 CHECK (uses >= 0),
  revoked    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Which invite code each lady signed up with (NULL for gentlemen / legacy users).
ALTER TABLE users ADD COLUMN IF NOT EXISTS invite_code_id TEXT REFERENCES invite_codes(id);
