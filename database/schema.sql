CREATE TABLE IF NOT EXISTS app_sessions (
  sid_hash TEXT PRIMARY KEY,
  authenticated BOOLEAN NOT NULL DEFAULT FALSE,
  oauth_state TEXT,
  oauth_expires_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS app_sessions_expires_at_idx
  ON app_sessions (expires_at);

CREATE TABLE IF NOT EXISTS instagram_accounts (
  owner_id TEXT NOT NULL,
  ig_user_id TEXT NOT NULL,
  username TEXT NOT NULL,
  access_token TEXT NOT NULL,
  login_type TEXT NOT NULL,
  permissions JSONB NOT NULL DEFAULT '[]'::jsonb,
  token_expires_at TIMESTAMPTZ,
  connected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (owner_id, ig_user_id)
);

CREATE TABLE IF NOT EXISTS published_posts (
  id BIGSERIAL PRIMARY KEY,
  owner_id TEXT NOT NULL,
  ig_user_id TEXT NOT NULL,
  username TEXT NOT NULL,
  media_type TEXT NOT NULL,
  post_url TEXT,
  media_id TEXT NOT NULL,
  published_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS published_posts_owner_date_idx
  ON published_posts (owner_id, published_at DESC);
