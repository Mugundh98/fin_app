-- D1 schema. Apply with:
--     npx wrangler d1 execute finapp --remote --file=db/schema.sql
--
-- Three tables and nothing more. This stores what a signed-in user typed
-- into the planners; it is not an analytics store and should never grow
-- into one.

CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,          -- Google's `sub`: stable, unique, never reused
  email       TEXT NOT NULL,
  name        TEXT,
  created_at  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL
);

-- Sessions hold a HASH of the token, never the token itself. A leaked
-- database therefore cannot be used to impersonate anyone: the cookie value
-- is the only thing that opens a session, and it exists solely in the
-- user's browser.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS sessions_user   ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);

-- One row per planner per user. The value is the same JSON the browser
-- already stores locally, so the client needs no new shape to talk to this.
CREATE TABLE IF NOT EXISTS state (
  user_id     TEXT NOT NULL,
  key         TEXT NOT NULL,
  value       TEXT NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, key),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
