import { config } from '../config.js';

const v = config.version;
const isIG = config.loginType === 'instagram';

export function redact(text) {
  return String(text ?? '')
    .replace(/(access_token|client_secret|code)=([^&\s"]+)/gi, '$1=[redacted]')
    .replace(/\b(IG|EA)[A-Za-z0-9]{40,}\b/g, '[redacted]')
    .replace(config.appSecret ? new RegExp(config.appSecret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g') : /$^/, '[redacted]');
}

async function call(url, opts, stage) {
  let res;
  try { res = await fetch(url, opts); }
  catch (err) { const e = new Error(`Network error during ${stage}: ${redact(err.message)}`); e.stage = stage; throw e; }
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error || body.error_message) {
    const m = body.error?.message || body.error_message || `HTTP ${res.status}`;
    const e = new Error(redact(m));
    e.stage = stage; e.metaCode = body.error?.code; e.metaSubcode = body.error?.error_subcode;
    throw e;
  }
  return body;
}
const form = (o) => ({ method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(o) });
const graphForm = (fields) => {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.append(key, String(value));
  return { method: 'POST', body };
};
const qs = (o) => new URLSearchParams(o).toString();

export function authorizationUrl(state) {
  const params = { client_id: config.appId, redirect_uri: config.redirectUri, response_type: 'code', scope: config.scopes.join(','), state };
  return isIG ? `https://www.instagram.com/oauth/authorize?${qs(params)}` : `https://www.facebook.com/${v}/dialog/oauth?${qs(params)}`;
}

// Returns { accessToken (the one used for publishing), igUserId, username, permissions[], expiresAt, notes[] }
export async function completeLogin(code) {
  return isIG ? igLogin(code) : fbLogin(code);
}

async function igLogin(code) {
  const notes = [];
  const raw = await call('https://api.instagram.com/oauth/access_token', form({
    client_id: config.appId, client_secret: config.appSecret, grant_type: 'authorization_code',
    redirect_uri: config.redirectUri, code }), 'token_exchange');
  const first = Array.isArray(raw.data) ? raw.data[0] : raw;
  let token = first.access_token;
  let expiresAt = null;
  let permissions = first.permissions ?? [];
  if (typeof permissions === 'string') permissions = permissions.split(',');
  try {
    const ll = await call(`https://graph.instagram.com/access_token?${qs({ grant_type: 'ig_exchange_token', client_secret: config.appSecret, access_token: token })}`, {}, 'long_lived_exchange');
    token = ll.access_token; expiresAt = ll.expires_in ? Date.now() + ll.expires_in * 1000 : null;
    notes.push('Exchanged for long-lived token');
  } catch (err) { notes.push(`Long-lived exchange failed, using short-lived token: ${err.message}`); }
  const me = await call(`https://graph.instagram.com/${v}/me?${qs({ fields: 'user_id,username', access_token: token })}`, {}, 'account_lookup');
  return { accessToken: token, igUserId: String(me.user_id || first.user_id), username: me.username, permissions, expiresAt, notes };
}

async function fbLogin(code) {
  const notes = [];
  const short = await call(`https://graph.facebook.com/${v}/oauth/access_token?${qs({ client_id: config.appId, client_secret: config.appSecret, redirect_uri: config.redirectUri, code })}`, {}, 'token_exchange');
  let userToken = short.access_token, expiresAt = null;
  try {
    const ll = await call(`https://graph.facebook.com/${v}/oauth/access_token?${qs({ grant_type: 'fb_exchange_token', client_id: config.appId, client_secret: config.appSecret, fb_exchange_token: userToken })}`, {}, 'long_lived_exchange');
    userToken = ll.access_token; expiresAt = ll.expires_in ? Date.now() + ll.expires_in * 1000 : null;
  } catch (err) { notes.push(`Long-lived exchange failed: ${err.message}`); }
  const pages = await call(`https://graph.facebook.com/${v}/me/accounts?${qs({ fields: 'id,name,access_token,instagram_business_account{id,username}', access_token: userToken })}`, {}, 'page_lookup');
  const linked = (pages.data || []).filter((p) => p.instagram_business_account);
  if (!linked.length) {
    const e = new Error('No Facebook Page with a linked Instagram professional account was found. Link your IG Business/Creator account to a Page you manage, and grant that Page during login.');
    e.stage = 'page_lookup'; throw e;
  }
  const page = linked[0];
  if (linked.length > 1) notes.push(`${linked.length} Pages have linked Instagram accounts; using "${page.name}". Others: ${linked.slice(1).map((p) => p.name).join(', ')}`);
  let permissions = [];
  try {
    const perms = await call(`https://graph.facebook.com/${v}/me/permissions?${qs({ access_token: userToken })}`, {}, 'permissions_lookup');
    permissions = (perms.data || []).filter((p) => p.status === 'granted').map((p) => p.permission);
  } catch (err) { notes.push(`Could not read permissions: ${err.message}`); }
  return { accessToken: page.access_token, igUserId: page.instagram_business_account.id, username: page.instagram_business_account.username, permissions, expiresAt, notes };
}

const base = (id) => (isIG ? `https://graph.instagram.com/${v}/${id}` : `https://graph.facebook.com/${v}/${id}`);

export const createReelContainer = (conn, videoUrl, caption) =>
  call(base(`${conn.igUserId}/media`), graphForm({ media_type: 'REELS', video_url: videoUrl, caption, access_token: conn.accessToken }), 'create_container');

export const getContainerStatus = (conn, containerId) =>
  call(`${base(containerId)}?${qs({ fields: 'status_code,status', access_token: conn.accessToken })}`, {}, 'poll_status');

export const publishContainer = (conn, containerId) =>
  call(base(`${conn.igUserId}/media_publish`), graphForm({ creation_id: containerId, access_token: conn.accessToken }), 'publish');

export const createImageContainer = (conn, imageUrl, caption) =>
  call(base(`${conn.igUserId}/media`), graphForm({ image_url: imageUrl, caption, access_token: conn.accessToken }), 'create_container');

export const createCarouselItem = (conn, mediaUrl, mediaType) =>
  call(base(`${conn.igUserId}/media`), graphForm({
    [mediaType === 'VIDEO' ? 'video_url' : 'image_url']: mediaUrl,
    ...(mediaType === 'VIDEO' ? { media_type: 'VIDEO' } : {}),
    is_carousel_item: 'true',
    access_token: conn.accessToken,
  }), 'create_carousel_item');

export const createCarouselContainer = (conn, childIds, caption) =>
  call(base(`${conn.igUserId}/media`), graphForm({
    media_type: 'CAROUSEL',
    children: childIds.join(','),
    caption,
    access_token: conn.accessToken,
  }), 'create_container');

export const getMediaPermalink = (conn, mediaId) =>
  call(`${base(mediaId)}?${qs({ fields: 'permalink', access_token: conn.accessToken })}`, {}, 'media_permalink');
