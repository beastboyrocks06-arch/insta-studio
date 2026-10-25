import crypto from 'node:crypto';
import pg from 'pg';
import { config } from './config.js';

const { Pool } = pg;
let pool;

function getPool() {
  if (!config.databaseUrl) throw new Error('DATABASE_URL is missing. Configure the Neon connection string in the server environment.');
  let databaseUrl;
  try {
    databaseUrl = new URL(config.databaseUrl);
  } catch {
    throw Object.assign(new Error('DATABASE_URL must be a valid PostgreSQL connection URL.'), { status: 503 });
  }
  if (!databaseUrl.pathname || databaseUrl.pathname === '/') {
    throw Object.assign(new Error('DATABASE_URL is missing its database name. Copy the full Neon connection string, including the database name after the host.'), { status: 503 });
  }
  if (!pool) {
    pool = new Pool({
      connectionString: config.databaseUrl,
      ssl: { rejectUnauthorized: true },
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    pool.on('error', (error) => console.error('Unexpected Neon database pool error:', error.code || error.name));
  }
  return pool;
}

const ownerId = () => config.appUsername.trim().toLowerCase();
export const sessionCookieOptions = () => ({
  httpOnly: true,
  sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production',
  maxAge: 30 * 24 * 60 * 60 * 1000,
});
const hashSessionId = (sessionId) => crypto.createHash('sha256').update(sessionId).digest('hex');
const expiresAt = () => new Date(Date.now() + sessionCookieOptions().maxAge);

export async function findSession(sessionId) {
  const result = await getPool().query(
    `UPDATE app_sessions SET expires_at = $2, updated_at = NOW()
     WHERE sid_hash = $1 AND expires_at > NOW()
     RETURNING authenticated, oauth_state, oauth_expires_at`,
    [hashSessionId(sessionId), expiresAt()],
  );
  const row = result.rows[0];
  return row ? {
    sid: sessionId,
    authenticated: row.authenticated,
    oauth: row.oauth_state ? { state: row.oauth_state, expires: new Date(row.oauth_expires_at).getTime() } : null,
    debug: { stage: 'idle', processing: null, log: [], result: null, error: null },
    busy: false,
  } : null;
}

export async function saveSession(session) {
  await getPool().query(
    `INSERT INTO app_sessions (sid_hash, authenticated, oauth_state, oauth_expires_at, expires_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (sid_hash) DO UPDATE SET
       authenticated = EXCLUDED.authenticated,
       oauth_state = EXCLUDED.oauth_state,
       oauth_expires_at = EXCLUDED.oauth_expires_at,
       expires_at = EXCLUDED.expires_at,
       updated_at = NOW()`,
    [hashSessionId(session.sid), session.authenticated, session.oauth?.state || null,
      session.oauth ? new Date(session.oauth.expires) : null, expiresAt()],
  );
}

export async function removeSession(sessionId) {
  await getPool().query('DELETE FROM app_sessions WHERE sid_hash = $1', [hashSessionId(sessionId)]);
}

export async function listAccounts() {
  const result = await getPool().query(
    `SELECT ig_user_id AS id, username, permissions, token_expires_at AS "expiresAt"
     FROM instagram_accounts WHERE owner_id = $1 ORDER BY connected_at`,
    [ownerId()],
  );
  return result.rows.map((row) => ({ ...row, id: String(row.id) }));
}

export async function findAccounts(accountIds) {
  if (!accountIds.length) return [];
  const result = await getPool().query(
    `SELECT ig_user_id AS "igUserId", username, access_token AS "accessToken",
            login_type AS "loginType", permissions, token_expires_at AS "expiresAt"
     FROM instagram_accounts
     WHERE owner_id = $1 AND ig_user_id = ANY($2::text[])`,
    [ownerId(), accountIds.map(String)],
  );
  return result.rows;
}

export async function saveAccount(connection) {
  await getPool().query(
    `INSERT INTO instagram_accounts
       (owner_id, ig_user_id, username, access_token, login_type, permissions, token_expires_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
     ON CONFLICT (owner_id, ig_user_id) DO UPDATE SET
       username = EXCLUDED.username,
       access_token = EXCLUDED.access_token,
       login_type = EXCLUDED.login_type,
       permissions = EXCLUDED.permissions,
       token_expires_at = EXCLUDED.token_expires_at,
       updated_at = NOW()`,
    [ownerId(), String(connection.igUserId), connection.username, connection.accessToken,
      connection.loginType, JSON.stringify(connection.permissions || []),
      connection.expiresAt ? new Date(connection.expiresAt) : null],
  );
}

export async function removeAccount(accountId) {
  const result = await getPool().query(
    'DELETE FROM instagram_accounts WHERE owner_id = $1 AND ig_user_id = $2',
    [ownerId(), String(accountId)],
  );
  return result.rowCount > 0;
}

export async function recordPublishedPost(post) {
  const result = await getPool().query(
    `INSERT INTO published_posts (owner_id, ig_user_id, username, media_type, post_url, media_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING published_at AS "publishedAt"`,
    [ownerId(), String(post.accountId), post.username, post.mediaType, post.postUrl || null, String(post.mediaId)],
  );
  return result.rows[0];
}

export async function getPublishedPosts() {
  const result = await getPool().query(
    `SELECT published_at AS date, username AS account, media_type AS "mediaType",
            post_url AS "postUrl", media_id AS "mediaId"
     FROM published_posts WHERE owner_id = $1 ORDER BY published_at`,
    [ownerId()],
  );
  return result.rows;
}
